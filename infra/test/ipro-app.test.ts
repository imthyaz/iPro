import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../lib/ipro-app.js';
import { IproPrereqStack } from '../lib/ipro-prereq-stack.js';
import { IproStack, PRIMARY_REGION } from '../lib/ipro-stack.js';
import { stageSettings } from '../lib/stage-settings.js';

const env = { account: '111111111111', region: PRIMARY_REGION };
const settings = (over: Record<string, string> = {}): AppSettings => ({
  domainName: 'ipro-staging.example.test',
  certificateArn: 'arn:aws:acm:ap-south-1:111111111111:certificate/test',
  imageTag: 'abc123',
  desiredCount: 1,
  environment: {
    TENANT_ID: '00000000-0000-4000-8000-000000000001',
    LLM_PROVIDER: 'none',
    ...over,
  },
});
const synth = (s?: AppSettings) => {
  const app = new App();
  const prereq = new IproPrereqStack(app, 'prereq', { stage: 'staging', env });
  const main = new IproStack(app, 'main', {
    stage: 'staging',
    env,
    ...(s && { app: { settings: s, prereq } }),
  });
  return { main: Template.fromStack(main), prereq: Template.fromStack(prereq) };
};

interface ContainerDef {
  Name: string;
  Environment: { Name: string; Value: unknown }[];
  Secrets: { Name: string }[];
}
const apiContainer = (t: Template): ContainerDef =>
  Object.values(t.findResources('AWS::ECS::TaskDefinition'))
    .flatMap(
      (r) =>
        (r as { Properties: { ContainerDefinitions: ContainerDef[] } }).Properties
          .ContainerDefinitions,
    )
    .find((c) => c.Name === 'api')!;

describe('the running app (decision #100)', () => {
  it('is left out until there are images to run', () => {
    synth().main.resourceCountIs('AWS::ECS::Service', 0);
  });

  it('runs the API and web app on Fargate in private subnets, rolling back a failed deploy', () => {
    const { main } = synth(settings());
    main.resourceCountIs('AWS::ECS::Service', 2);
    main.allResourcesProperties('AWS::ECS::Service', {
      LaunchType: 'FARGATE',
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        MinimumHealthyPercent: 100,
      }),
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }),
      },
    });
  });

  it('migrates before the API starts, in every new task', () => {
    synth(settings()).main.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'migrate',
          Essential: false,
          Command: ['node', 'dist/db/migrate-cli.js'],
        }),
        Match.objectLike({
          Name: 'api',
          DependsOn: [{ Condition: 'SUCCESS', ContainerName: 'migrate' }],
        }),
      ]),
    });
  });

  it('configures the API for production, with secrets only from Secrets Manager', () => {
    const api = apiContainer(synth(settings()).main);
    const vars = Object.fromEntries(api.Environment.map((e) => [e.Name, e.Value]));
    expect(vars).toMatchObject({
      NODE_ENV: 'production',
      APP_URL: 'https://ipro-staging.example.test',
      OIDC_REDIRECT_URI: 'https://ipro-staging.example.test/api/auth/callback',
      DATABASE_SSL: 'verify',
      FIELD_KEY_PROVIDER: 'kms',
      STORAGE_PROVIDER: 's3',
      ESIGN_PROVIDER: 'zoho',
      TRUST_PROXY_HOPS: '1',
      TENANT_ID: '00000000-0000-4000-8000-000000000001',
    });
    const secretNames = api.Secrets.map((s) => s.Name);
    expect(secretNames).toEqual(
      expect.arrayContaining([
        'DATABASE_PASSWORD',
        'ENTRA_CLIENT_SECRET',
        'ZOHO_SIGN_WEBHOOK_SECRET',
      ]),
    );
    for (const name of secretNames) expect(vars[name]).toBeUndefined();
  });

  it('serves both over HTTPS on one address: /api/* to the API, the rest to the web app', () => {
    const { main } = synth(settings());
    main.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      Certificates: [{ CertificateArn: 'arn:aws:acm:ap-south-1:111111111111:certificate/test' }],
    });
    main.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: 'redirect' })],
    });
    main.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 10,
      Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }],
    });
    main.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/api/health/live',
    });
    main.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([
        { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
      ]),
    });
  });

  it('puts a web firewall in front, without blocking uploads', () => {
    const { main } = synth(settings());
    main.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    main.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWSManagedRulesCommonRuleSet',
          Statement: {
            ManagedRuleGroupStatement: Match.objectLike({
              RuleActionOverrides: [{ Name: 'SizeRestrictions_BODY', ActionToUse: { Count: {} } }],
            }),
          },
        }),
        Match.objectLike({ Name: 'RatePerAddress', Action: { Block: {} } }),
      ]),
    });
  });

  it('only the API reaches the database; Bedrock only when Ask iPro is on', () => {
    const { main } = synth(settings());
    main.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      Description: 'API tasks',
    });
    expect(JSON.stringify(main.toJSON())).not.toContain('bedrock:InvokeModel');
    const withAsk = synth(
      settings({
        LLM_PROVIDER: 'bedrock',
        BEDROCK_MODEL_LOOKUP: 'in.anthropic.test',
        BEDROCK_MODEL_REASONING: 'in.anthropic.test',
      }),
    ).main;
    expect(JSON.stringify(withAsk.toJSON())).toContain('inference-profile/in.*');
  });

  it('keeps images and secrets in their own stack, deployed first', () => {
    const { prereq } = synth();
    prereq.resourceCountIs('AWS::ECR::Repository', 2);
    prereq.allResourcesProperties('AWS::ECR::Repository', {
      ImageTagMutability: 'IMMUTABLE',
      ImageScanningConfiguration: { ScanOnPush: true },
    });
    prereq.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'ipro/staging/app',
      GenerateSecretString: Match.objectLike({
        SecretStringTemplate: Match.stringLikeRegexp('"ENTRA_CLIENT_SECRET":"REPLACE_ME"'),
      }),
    });
  });
});

describe('stage settings files (decision #100)', () => {
  const write = (content: object) => {
    const file = join(mkdtempSync(join(tmpdir(), 'stage-')), 'staging.json');
    writeFileSync(file, JSON.stringify(content));
    return pathToFileURL(file);
  };
  const filled = {
    domainName: 'ipro-staging.example.test',
    certificateArn: 'arn:aws:acm:ap-south-1:1:certificate/x',
    desiredCount: 1,
    environment: { TENANT_ID: 'x' },
  };

  it('leaves the app out without an image tag', () => {
    expect(stageSettings('staging', undefined, write(filled))).toBeUndefined();
  });

  it('refuses settings still at REPLACE_ME, naming each', () => {
    const half = {
      ...filled,
      certificateArn: 'REPLACE_ME',
      environment: { TENANT_ID: 'REPLACE_ME' },
    };
    expect(() => stageSettings('staging', 'abc', write(half))).toThrow(
      'certificateArn, environment.TENANT_ID',
    );
  });

  it('adds the image tag to filled settings', () => {
    expect(stageSettings('staging', 'abc', write(filled))).toEqual({ ...filled, imageTag: 'abc' });
  });
});
