import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { IproApp, type AppSettings } from './ipro-app.js';
import type { IproPrereqStack } from './ipro-prereq-stack.js';

/** Personal data stays in India (DPDP): Mumbai primary, Hyderabad for disaster recovery. */
export const PRIMARY_REGION = 'ap-south-1';
export const DR_REGION = 'ap-south-2';

export interface IproStackProps extends StackProps {
  stage: 'dev' | 'staging' | 'prod';
  /** The Hyderabad vault and key (IproDrStack). Without them nothing is copied out of Mumbai. */
  dr?: { vault: backup.IBackupVault; key: kms.IKey };
  /** Run the app (decision #100). Without it the stack holds data, keys and backups only. */
  app?: { settings: AppSettings; prereq: IproPrereqStack };
}

/**
 * Backups (spec: nightly full backup plus point-in-time recovery; lose no more than 15 minutes, back
 * up within 4 hours; decision #98). Kept 35 days in production, 7 elsewhere.
 */
export const backupRetentionDays = (stage: IproStackProps['stage']) => (stage === 'prod' ? 35 : 7);

export class IproStack extends Stack {
  constructor(scope: Construct, id: string, props: IproStackProps) {
    super(scope, id, props);
    if (props.env?.region !== PRIMARY_REGION) {
      throw new Error(`iPro stacks must be deployed to ${PRIMARY_REGION}`);
    }
    const isProd = props.stage === 'prod';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    // Envelope key for field-level encryption of KYC and compensation. Multi-Region, with a replica in
    // Hyderabad (IproDrKeysStack), so a database restored there can still read those fields
    // (decision #98). Can't be changed after the key exists.
    const fieldKey = new kms.Key(this, 'FieldEncryptionKey', {
      alias: `alias/ipro-${props.stage}-fields`,
      enableKeyRotation: true,
      multiRegion: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const storageKey = new kms.Key(this, 'StorageKey', {
      alias: `alias/ipro-${props.stage}-storage`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const documents = new s3.Bucket(this, 'Documents', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: storageKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const retention = Duration.days(backupRetentionDays(props.stage));
    // Point-in-time recovery comes from the automated backups: transaction logs every 5 minutes.
    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      credentials: rds.Credentials.fromGeneratedSecret('ipro_admin'),
      databaseName: 'ipro',
      storageEncrypted: true,
      storageEncryptionKey: storageKey,
      multiAz: isProd,
      backupRetention: retention,
      preferredBackupWindow: '20:00-20:30', // 01:30–02:00 IST, before the nightly plan
      deletionProtection: isProd,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.SNAPSHOT,
    });

    // The automated backups (and so point-in-time recovery) are also kept in Hyderabad, so a regional
    // outage loses minutes, not a day.
    if (props.dr) {
      const cfn = database.node.defaultChild as rds.CfnDBInstance;
      cfn.addPropertyOverride('AutomaticBackupReplicationRegion', DR_REGION);
      cfn.addPropertyOverride('AutomaticBackupReplicationKmsKeyId', props.dr.key.keyArn);
    }

    // Nightly at 02:00 IST: the database and the documents bucket, copied to Hyderabad.
    const vault = new backup.BackupVault(this, 'Vault', {
      backupVaultName: `ipro-${props.stage}`,
      encryptionKey: storageKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const plan = new backup.BackupPlan(this, 'NightlyBackup', {
      backupPlanName: `ipro-${props.stage}-nightly`,
      backupVault: vault,
    });
    plan.addRule(
      new backup.BackupPlanRule({
        ruleName: 'nightly',
        scheduleExpression: events.Schedule.cron({ minute: '30', hour: '20' }),
        startWindow: Duration.hours(1),
        completionWindow: Duration.hours(4),
        deleteAfter: retention,
        ...(props.dr && {
          copyActions: [{ destinationBackupVault: props.dr.vault, deleteAfter: retention }],
        }),
      }),
    );
    plan.addSelection('DataStores', {
      resources: [
        backup.BackupResource.fromRdsDatabaseInstance(database),
        backup.BackupResource.fromArn(documents.bucketArn),
      ],
    });

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsights: true });

    if (props.app) {
      this.app = new IproApp(this, 'App', {
        stage: props.stage,
        vpc,
        cluster,
        database,
        documents,
        fieldKey,
        settings: props.app.settings,
        prereq: props.app.prereq,
      });
    }

    // Exposed for later slices (API task role grants).
    this.fieldEncryptionKeyArn = fieldKey.keyArn;
  }

  readonly fieldEncryptionKeyArn: string;
  readonly app?: IproApp;
}
