import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Short-lived download links (spec: "signed, short-lived download links"). */
export const DOWNLOAD_LINK_SECONDS = 300;

/** Object storage for documents. Keys never contain names or other personal data. */
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** A link that downloads the object as `fileName`, valid for DOWNLOAD_LINK_SECONDS. */
  downloadUrl(key: string, fileName: string, contentType: string): Promise<string>;
}

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Local S3 stand-in (SeaweedFS); omit in AWS. */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** AWS S3 (bucket encrypted with KMS by the CDK stack) or a local S3-compatible server. */
export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: Boolean(options.endpoint),
      credentials:
        options.accessKeyId && options.secretAccessKey
          ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
          : undefined,
    });
  }

  /** Local only: creates the bucket on first start. In AWS the CDK stack owns the bucket. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.options.bucket }));
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  downloadUrl(key: string, fileName: string, contentType: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ResponseContentType: contentType,
        ResponseContentDisposition: contentDisposition(fileName),
      }),
      { expiresIn: DOWNLOAD_LINK_SECONDS },
    );
  }
}

/** In-memory storage for tests. */
export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }

  async downloadUrl(key: string, fileName: string): Promise<string> {
    if (!this.objects.has(key)) throw new Error('No such object');
    return `memory://${encodeURIComponent(key)}?name=${encodeURIComponent(fileName)}`;
  }
}

/** RFC 6266 attachment header with a safe ASCII fallback name. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
