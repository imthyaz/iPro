import { App } from 'aws-cdk-lib';
import { IproStack, PRIMARY_REGION } from '../lib/ipro-stack.js';

// Skeleton only: synthesised locally and in CI, never deployed until the account owner provides access.
const app = new App();
new IproStack(app, 'ipro-dev', {
  stage: 'dev',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: PRIMARY_REGION },
});
