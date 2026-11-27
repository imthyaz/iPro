import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { PRIMARY_REGION } from './ipro-stack.js';

/** Filled in by an operator before the app is deployed (docs/runbooks/deploy.md). */
export const APP_SECRET_KEYS = [
  'ENTRA_CLIENT_SECRET',
  'GRAPH_CLIENT_SECRET',
  'ZOHO_SIGN_CLIENT_SECRET',
  'ZOHO_SIGN_REFRESH_TOKEN',
  'ZOHO_SIGN_WEBHOOK_SECRET',
  'TEAMS_BOT_APP_SECRET',
] as const;

export interface IproPrereqStackProps extends StackProps {
  stage: 'dev' | 'staging' | 'prod';
}

/**
 * What must exist before the app can run (decision #100): the image repositories (images are pushed
 * before the app stack deploys) and the app secret (an operator fills it first). Deployed first.
 */
export class IproPrereqStack extends Stack {
  readonly apiRepository: ecr.Repository;
  readonly webRepository: ecr.Repository;
  readonly appSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: IproPrereqStackProps) {
    super(scope, id, props);
    if (props.env?.region !== PRIMARY_REGION) {
      throw new Error(`iPro stacks must be deployed to ${PRIMARY_REGION}`);
    }
    const repository = (name: 'api' | 'web') =>
      new ecr.Repository(this, `${name}Repository`, {
        repositoryName: `ipro-${props.stage}-${name}`,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        lifecycleRules: [{ maxImageCount: 30 }],
        removalPolicy: RemovalPolicy.RETAIN,
      });
    this.apiRepository = repository('api');
    this.webRepository = repository('web');
    this.appSecret = new secretsmanager.Secret(this, 'AppSecret', {
      secretName: `ipro/${props.stage}/app`,
      description: 'iPro API secrets: replace every REPLACE_ME before deploying the app',
      generateSecretString: {
        secretStringTemplate: JSON.stringify(
          Object.fromEntries(APP_SECRET_KEYS.map((key) => [key, 'REPLACE_ME'])),
        ),
        generateStringKey: 'UNUSED',
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    new CfnOutput(this, 'ApiRepositoryUri', { value: this.apiRepository.repositoryUri });
    new CfnOutput(this, 'WebRepositoryUri', { value: this.webRepository.repositoryUri });
    new CfnOutput(this, 'AppSecretName', { value: this.appSecret.secretName });
  }
}
