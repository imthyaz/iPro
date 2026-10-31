import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/** Personal data stays in India (DPDP): Mumbai primary, Hyderabad for disaster recovery. */
export const PRIMARY_REGION = 'ap-south-1';
export const DR_REGION = 'ap-south-2';

export interface IproStackProps extends StackProps {
  stage: 'dev' | 'staging' | 'prod';
}

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

    // Envelope key for field-level encryption of KYC and compensation.
    const fieldKey = new kms.Key(this, 'FieldEncryptionKey', {
      alias: `alias/ipro-${props.stage}-fields`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const storageKey = new kms.Key(this, 'StorageKey', {
      alias: `alias/ipro-${props.stage}-storage`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new s3.Bucket(this, 'Documents', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: storageKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      credentials: rds.Credentials.fromGeneratedSecret('ipro_admin'),
      storageEncrypted: true,
      storageEncryptionKey: storageKey,
      multiAz: isProd,
      backupRetention: Duration.days(isProd ? 35 : 7),
      deletionProtection: isProd,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.SNAPSHOT,
    });

    new ecs.Cluster(this, 'Cluster', { vpc, containerInsights: true });

    // Exposed for later slices (API task role grants).
    this.fieldEncryptionKeyArn = fieldKey.keyArn;
  }

  readonly fieldEncryptionKeyArn: string;
}
