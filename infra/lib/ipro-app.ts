import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { APP_SECRET_KEYS } from './ipro-prereq-stack.js';

/**
 * Settings for running iPro in a stage (decision #100). Nothing here is secret: secrets live in the
 * stage's app secret (IproPrereqStack), filled in by an operator.
 */
export interface AppSettings {
  /** The address people use, e.g. ipro-staging.ideassion.com. */
  domainName: string;
  /** An ACM certificate for that name, in ap-south-1. */
  certificateArn: string;
  /** Image tag to run (the git commit), pushed to both repositories before deploying. */
  imageTag: string;
  /** Tasks per service: 2+ in production so a deploy or a lost task never takes iPro down. */
  desiredCount: number;
  /** Non-secret API settings (tenant, Entra ids, provider choices, model ids, ...). */
  environment: Record<string, string>;
}

export interface IproAppProps {
  stage: 'dev' | 'staging' | 'prod';
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  database: rds.DatabaseInstance;
  documents: s3.IBucket;
  fieldKey: kms.IKey;
  settings: AppSettings;
  /** Repositories and the app secret (IproPrereqStack). */
  prereq: {
    apiRepository: ecr.IRepository;
    webRepository: ecr.IRepository;
    appSecret: secretsmanager.ISecret;
  };
}

/**
 * The running app (decision #100): the API and web images on Fargate in the private subnets, behind
 * one HTTPS load balancer that sends /api/* to the API and everything else to the web app, so both
 * share one origin. A web firewall sits in front. Each new API task runs the migrations first.
 */
export class IproApp extends Construct {
  readonly apiService: ecs.FargateService;
  readonly webService: ecs.FargateService;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: IproAppProps) {
    super(scope, id);
    const { stage, settings } = props;
    const isProd = stage === 'prod';
    const region = Stack.of(this).region;

    const { apiRepository, webRepository, appSecret } = props.prereq;

    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/ipro/${stage}/${name.toLowerCase()}`,
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.RETAIN,
      });

    // ---- API: migrate, then serve ----
    const api = new ecs.FargateTaskDefinition(this, 'ApiTask', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const dbSecret = props.database.secret!;
    const environment: Record<string, string> = {
      NODE_ENV: 'production',
      APP_URL: `https://${settings.domainName}`,
      OIDC_REDIRECT_URI: `https://${settings.domainName}/api/auth/callback`,
      DATABASE_NAME: 'ipro',
      DATABASE_SSL: 'verify',
      FIELD_KEY_PROVIDER: 'kms',
      KMS_KEY_ID: props.fieldKey.keyArn,
      AWS_REGION: region,
      STORAGE_PROVIDER: 's3',
      S3_BUCKET: props.documents.bucketName,
      ESIGN_PROVIDER: 'zoho',
      TRUST_PROXY_HOPS: '1',
      ...settings.environment,
    };
    const secrets: Record<string, ecs.Secret> = {
      DATABASE_HOST: ecs.Secret.fromSecretsManager(dbSecret, 'host'),
      DATABASE_PORT: ecs.Secret.fromSecretsManager(dbSecret, 'port'),
      DATABASE_USER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
      DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
      ...Object.fromEntries(
        APP_SECRET_KEYS.map((key) => [key, ecs.Secret.fromSecretsManager(appSecret, key)]),
      ),
    };
    const apiImage = ecs.ContainerImage.fromEcrRepository(apiRepository, settings.imageTag);
    const apiLogs = logGroup('Api');
    const migrate = api.addContainer('migrate', {
      image: apiImage,
      command: ['node', 'dist/db/migrate-cli.js'],
      essential: false,
      environment: { ...environment, JOBS_ENABLED: 'false' },
      secrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup: apiLogs, streamPrefix: 'migrate' }),
    });
    const apiContainer = api.addContainer('api', {
      image: apiImage,
      environment,
      secrets,
      portMappings: [{ containerPort: 3000 }],
      logging: ecs.LogDrivers.awsLogs({ logGroup: apiLogs, streamPrefix: 'api' }),
    });
    apiContainer.addContainerDependencies({
      container: migrate,
      condition: ecs.ContainerDependencyCondition.SUCCESS,
    });

    // What the API may touch: its documents, the field key, and (when on) India-only Bedrock models.
    props.documents.grantReadWrite(api.taskRole);
    props.fieldKey.grantEncryptDecrypt(api.taskRole);
    props.fieldKey.grant(api.taskRole, 'kms:GenerateDataKey');
    if (environment.LLM_PROVIDER === 'bedrock') {
      api.taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [
            `arn:aws:bedrock:${region}:${Stack.of(this).account}:inference-profile/in.*`,
            'arn:aws:bedrock:ap-south-*::foundation-model/*',
          ],
        }),
      );
    }

    // ---- Web: nginx serving the built app ----
    const web = new ecs.FargateTaskDefinition(this, 'WebTask', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    web.addContainer('web', {
      image: ecs.ContainerImage.fromEcrRepository(webRepository, settings.imageTag),
      portMappings: [{ containerPort: 8080 }],
      logging: ecs.LogDrivers.awsLogs({ logGroup: logGroup('Web'), streamPrefix: 'web' }),
    });

    const service = (name: string, taskDefinition: ecs.FargateTaskDefinition) =>
      new ecs.FargateService(this, `${name}Service`, {
        cluster: props.cluster,
        taskDefinition,
        desiredCount: settings.desiredCount,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        circuitBreaker: { enable: true, rollback: true },
        enableExecuteCommand: false,
      });
    this.apiService = service('Api', api);
    this.webService = service('Web', web);
    props.database.connections.allowDefaultPortFrom(this.apiService, 'API tasks');

    // ---- One HTTPS address for both ----
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      dropInvalidHeaderFields: true,
      deletionProtection: isProd,
    });
    this.loadBalancer.addRedirect({ sourcePort: 80, targetPort: 443 });
    const https = this.loadBalancer.addListener('Https', {
      port: 443,
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      certificates: [
        acm.Certificate.fromCertificateArn(this, 'Certificate', settings.certificateArn),
      ],
    });
    https.addTargets('Web', {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.webService],
      healthCheck: { path: '/healthz' },
      deregistrationDelay: Duration.seconds(30),
    });
    https.addTargets('Api', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api/*'])],
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.apiService],
      healthCheck: { path: '/api/health/live' },
      deregistrationDelay: Duration.seconds(30),
    });

    // ---- Web firewall: AWS managed rules plus a per-address rate limit ----
    const managed = (name: string, priority: number, excluded: string[] = []) => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name,
          ruleActionOverrides: excluded.map((rule) => ({ name: rule, actionToUse: { count: {} } })),
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: name,
        sampledRequestsEnabled: true,
      },
    });
    const acl = new wafv2.CfnWebACL(this, 'Firewall', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `ipro-${stage}`,
        sampledRequestsEnabled: true,
      },
      rules: [
        managed('AWSManagedRulesAmazonIpReputationList', 1),
        // KYC scans, policy files and CSV imports are larger than the common set's 8 KB body limit.
        managed('AWSManagedRulesCommonRuleSet', 2, ['SizeRestrictions_BODY']),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 3),
        {
          name: 'RatePerAddress',
          priority: 4,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' } },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'RatePerAddress',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'FirewallAssociation', {
      resourceArn: this.loadBalancer.loadBalancerArn,
      webAclArn: acl.attrArn,
    });

    new CfnOutput(this, 'LoadBalancerDns', { value: this.loadBalancer.loadBalancerDnsName });
  }
}
