import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { IproDrKeysStack, IproDrStack } from '../lib/ipro-dr-stack.js';
import { DR_REGION, IproStack, PRIMARY_REGION } from '../lib/ipro-stack.js';

const synth = () =>
  Template.fromStack(
    new IproStack(new App(), 'test', { stage: 'dev', env: { region: PRIMARY_REGION } }),
  );

describe('IproStack', () => {
  it('refuses any region outside Mumbai', () => {
    expect(
      () => new IproStack(new App(), 'test', { stage: 'dev', env: { region: 'us-east-1' } }),
    ).toThrow('ap-south-1');
  });

  it('encrypts the documents bucket with KMS and blocks public access', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }),
          }),
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('runs encrypted PostgreSQL 16', () => {
    synth().hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^16'),
      StorageEncrypted: true,
    });
  });

  it('rotates the KMS keys', () => {
    synth().allResourcesProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });
});

/** A stage's Mumbai and Hyderabad stacks, wired as bin/ipro.ts wires them. */
const synthWithDr = (stage: 'dev' | 'staging' | 'prod') => {
  const app = new App();
  const dr = new IproDrStack(app, `dr-${stage}`, {
    stage,
    env: { account: '111111111111', region: DR_REGION },
    crossRegionReferences: true,
  });
  const main = new IproStack(app, `main-${stage}`, {
    stage,
    env: { account: '111111111111', region: PRIMARY_REGION },
    crossRegionReferences: true,
    dr: { vault: dr.vault, key: dr.key },
  });
  const keys = new IproDrKeysStack(app, `keys-${stage}`, {
    stage,
    env: { account: '111111111111', region: DR_REGION },
    crossRegionReferences: true,
    fieldKeyArn: main.fieldEncryptionKeyArn,
  });
  return {
    main: Template.fromStack(main),
    dr: Template.fromStack(dr),
    keys: Template.fromStack(keys),
  };
};

describe('backups and disaster recovery (slice 14c; decision #98)', () => {
  it('keeps point-in-time recovery: 35 days in production, 7 elsewhere', () => {
    synthWithDr('prod').main.hasResourceProperties('AWS::RDS::DBInstance', {
      BackupRetentionPeriod: 35,
    });
    synthWithDr('staging').main.hasResourceProperties('AWS::RDS::DBInstance', {
      BackupRetentionPeriod: 7,
    });
  });

  it('replicates the automated backups to Hyderabad, encrypted with the Hyderabad key', () => {
    synthWithDr('staging').main.hasResourceProperties('AWS::RDS::DBInstance', {
      AutomaticBackupReplicationRegion: DR_REGION,
      AutomaticBackupReplicationKmsKeyId: Match.anyValue(),
    });
  });

  it('backs up the database and the documents nightly at 02:00 IST, done within 4 hours', () => {
    const { main } = synthWithDr('prod');
    main.hasResourceProperties('AWS::Backup::BackupPlan', {
      BackupPlan: {
        BackupPlanName: 'ipro-prod-nightly',
        BackupPlanRule: [
          Match.objectLike({
            RuleName: 'nightly',
            ScheduleExpression: 'cron(30 20 * * ? *)',
            CompletionWindowMinutes: 240,
            Lifecycle: { DeleteAfterDays: 35 },
            CopyActions: [Match.objectLike({ Lifecycle: { DeleteAfterDays: 35 } })],
          }),
        ],
      },
    });
    const selection = main.findResources('AWS::Backup::BackupSelection');
    const resources = JSON.stringify(Object.values(selection)[0]);
    expect(resources).toContain('rds');
    expect(resources).toContain('Documents');
  });

  it('keeps every copy in India, encrypted and retained', () => {
    const { main, dr } = synthWithDr('prod');
    dr.hasResourceProperties('AWS::Backup::BackupVault', {
      BackupVaultName: 'ipro-prod-dr',
      EncryptionKeyArn: Match.anyValue(),
    });
    dr.hasResource('AWS::Backup::BackupVault', { DeletionPolicy: 'Retain' });
    main.hasResource('AWS::Backup::BackupVault', { DeletionPolicy: 'Retain' });
    dr.allResourcesProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  it('replicates the field-encryption key to Hyderabad, so restored KYC and pay can be read there', () => {
    const { main, keys } = synthWithDr('prod');
    main.hasResourceProperties('AWS::KMS::Key', {
      MultiRegion: true,
      EnableKeyRotation: true,
    });
    keys.hasResourceProperties('AWS::KMS::ReplicaKey', { PrimaryKeyArn: Match.anyValue() });
    keys.hasResource('AWS::KMS::ReplicaKey', { DeletionPolicy: 'Retain' });
    keys.hasResourceProperties('AWS::KMS::Alias', { AliasName: 'alias/ipro-prod-fields' });
  });

  it('refuses a DR stack outside Hyderabad', () => {
    expect(
      () => new IproDrStack(new App(), 'dr', { stage: 'dev', env: { region: PRIMARY_REGION } }),
    ).toThrow(DR_REGION);
  });

  it('copies nothing out of Mumbai when no DR vault is given', () => {
    const t = synth();
    t.hasResourceProperties('AWS::Backup::BackupPlan', {
      BackupPlan: { BackupPlanRule: [Match.objectLike({ CopyActions: Match.absent() })] },
    });
  });
});
