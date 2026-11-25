import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';
import { DR_REGION } from './ipro-stack.js';

export interface IproDrStackProps extends StackProps {
  stage: 'dev' | 'staging' | 'prod';
}

/**
 * Disaster recovery in Hyderabad (decision #5; decision #98): the vault that nightly backups are
 * copied to, and the key that encrypts them and the database's replicated automated backups.
 * Data stays in India.
 */
export class IproDrStack extends Stack {
  readonly vault: backup.BackupVault;
  readonly key: kms.Key;

  constructor(scope: Construct, id: string, props: IproDrStackProps) {
    super(scope, id, props);
    if (props.env?.region !== DR_REGION) {
      throw new Error(`The iPro DR stack must be deployed to ${DR_REGION}`);
    }
    this.key = new kms.Key(this, 'DrBackupKey', {
      alias: `alias/ipro-${props.stage}-dr-backup`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.vault = new backup.BackupVault(this, 'DrVault', {
      backupVaultName: `ipro-${props.stage}-dr`,
      encryptionKey: this.key,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}

export interface IproDrKeysStackProps extends StackProps {
  stage: 'dev' | 'staging' | 'prod';
  /** The Mumbai field-encryption key (multi-Region). */
  fieldKeyArn: string;
}

/**
 * The Hyderabad replica of the field-encryption key (decision #98). Same key material and id, so
 * KYC and compensation values encrypted in Mumbai can be decrypted by an iPro restored in Hyderabad.
 * Its own stack because it depends on the Mumbai stack, which depends on IproDrStack.
 */
export class IproDrKeysStack extends Stack {
  constructor(scope: Construct, id: string, props: IproDrKeysStackProps) {
    super(scope, id, props);
    if (props.env?.region !== DR_REGION) {
      throw new Error(`The iPro DR keys stack must be deployed to ${DR_REGION}`);
    }
    const replica = new kms.CfnReplicaKey(this, 'FieldKeyReplica', {
      primaryKeyArn: props.fieldKeyArn,
      description: `iPro ${props.stage} field encryption (replica of the Mumbai key)`,
      keyPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            principals: [new iam.AccountRootPrincipal()],
            actions: ['kms:*'],
            resources: ['*'],
          }),
        ],
      }),
    });
    replica.applyRemovalPolicy(RemovalPolicy.RETAIN);
    new kms.CfnAlias(this, 'FieldKeyReplicaAlias', {
      aliasName: `alias/ipro-${props.stage}-fields`,
      targetKeyId: replica.attrKeyId,
    });
  }
}
