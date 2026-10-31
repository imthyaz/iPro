import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { IproStack, PRIMARY_REGION } from '../lib/ipro-stack.js';

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
