import { App } from 'aws-cdk-lib';
import { IproDrKeysStack, IproDrStack } from '../lib/ipro-dr-stack.js';
import { IproPrereqStack } from '../lib/ipro-prereq-stack.js';
import { DR_REGION, IproStack, PRIMARY_REGION } from '../lib/ipro-stack.js';
import { stageSettings } from '../lib/stage-settings.js';

// Each stage: image repositories and the app secret (deployed first), a Hyderabad stack for backup
// copies, the Mumbai stack (data, keys, backups and, with -c imageTag=<sha>, the running app), and a
// Hyderabad stack for the replica of the field-encryption key (decisions #98, #100).
// Deploys go through .github/workflows/deploy.yml; see docs/runbooks/deploy.md.
const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const imageTag = app.node.tryGetContext('imageTag') as string | undefined;
const only = app.node.tryGetContext('stage') as string | undefined;
for (const stage of ['dev', 'staging', 'prod'] as const) {
  if (only && only !== stage) continue;
  const prereq = new IproPrereqStack(app, `ipro-${stage}-prereq`, {
    stage,
    env: { account, region: PRIMARY_REGION },
  });
  const dr = new IproDrStack(app, `ipro-${stage}-dr`, {
    stage,
    env: { account, region: DR_REGION },
    crossRegionReferences: true,
  });
  const settings = stageSettings(stage, imageTag);
  const main = new IproStack(app, `ipro-${stage}`, {
    stage,
    env: { account, region: PRIMARY_REGION },
    crossRegionReferences: true,
    dr: { vault: dr.vault, key: dr.key },
    ...(settings && { app: { settings, prereq } }),
  });
  new IproDrKeysStack(app, `ipro-${stage}-dr-keys`, {
    stage,
    env: { account, region: DR_REGION },
    crossRegionReferences: true,
    fieldKeyArn: main.fieldEncryptionKeyArn,
  });
}
