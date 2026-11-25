import { App } from 'aws-cdk-lib';
import { IproDrKeysStack, IproDrStack } from '../lib/ipro-dr-stack.js';
import { DR_REGION, IproStack, PRIMARY_REGION } from '../lib/ipro-stack.js';

// Skeleton only: synthesised locally and in CI, never deployed until the account owner provides access.
// Each stage has its Mumbai stack, a Hyderabad stack for backup copies, and a Hyderabad stack for the
// replica of the field-encryption key (decision #98).
const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
for (const stage of ['dev', 'staging'] as const) {
  const dr = new IproDrStack(app, `ipro-${stage}-dr`, {
    stage,
    env: { account, region: DR_REGION },
    crossRegionReferences: true,
  });
  const main = new IproStack(app, `ipro-${stage}`, {
    stage,
    env: { account, region: PRIMARY_REGION },
    crossRegionReferences: true,
    dr: { vault: dr.vault, key: dr.key },
  });
  new IproDrKeysStack(app, `ipro-${stage}-dr-keys`, {
    stage,
    env: { account, region: DR_REGION },
    crossRegionReferences: true,
    fieldKeyArn: main.fieldEncryptionKeyArn,
  });
}
