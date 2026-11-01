import { z } from 'zod';

const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);
const optionalText = z.preprocess(blankToUndefined, z.string().min(1).optional());

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    /** Phase 1 runs one tenant per deployment; later, the tenant comes from the hostname. */
    TENANT_ID: z.uuid(),
    JOBS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    ENTRA_TENANT_ID: optionalText,
    ENTRA_CLIENT_ID: optionalText,
    ENTRA_CLIENT_SECRET: optionalText,
    OIDC_REDIRECT_URI: z.preprocess(blankToUndefined, z.url().optional()),
    SESSION_IDLE_HOURS: z.coerce.number().positive().default(12),
    SESSION_MAX_DAYS: z.coerce.number().positive().default(7),

    FIELD_KEY_PROVIDER: z.enum(['local', 'kms']).default('local'),
    LOCAL_FIELD_KEY: optionalText,
    KMS_KEY_ID: optionalText,
    AWS_REGION: z.string().default('ap-south-1'),

    /** Documents: "s3" (AWS, or SeaweedFS locally via S3_ENDPOINT) or "memory" (tests only). */
    STORAGE_PROVIDER: z.enum(['s3', 'memory']).default('s3'),
    S3_BUCKET: z.string().min(1).default('ipro-dev-documents'),
    S3_ENDPOINT: z.preprocess(blankToUndefined, z.url().optional()),
    S3_ACCESS_KEY_ID: optionalText,
    S3_SECRET_ACCESS_KEY: optionalText,

    /** E-signature (decision #51): "fake" locally and in tests; Zoho Sign (India data centre) in AWS. */
    ESIGN_PROVIDER: z.enum(['fake', 'zoho']).default('fake'),
    ZOHO_SIGN_CLIENT_ID: optionalText,
    ZOHO_SIGN_CLIENT_SECRET: optionalText,
    ZOHO_SIGN_REFRESH_TOKEN: optionalText,
    ZOHO_ACCOUNTS_URL: z.url().default('https://accounts.zoho.in'),
    ZOHO_SIGN_URL: z.url().default('https://sign.zoho.in'),
    ZOHO_SIGN_WEBHOOK_SECRET: optionalText,
    ZOHO_SIGN_WEBHOOK_HEADER: z.string().default('X-ZS-WEBHOOK-SIGNATURE'),
  })
  .transform((env) => ({
    ...env,
    /** Entra when configured; otherwise the dev sign-in with synthetic users. */
    AUTH_MODE: (env.ENTRA_TENANT_ID ? 'entra' : 'dev') as 'entra' | 'dev',
  }))
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (env.AUTH_MODE === 'entra') {
      for (const key of ['ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'OIDC_REDIRECT_URI'] as const) {
        if (!env[key]) fail(key, 'required when ENTRA_TENANT_ID is set');
      }
    }
    if (env.FIELD_KEY_PROVIDER === 'local' && !env.LOCAL_FIELD_KEY) {
      fail('LOCAL_FIELD_KEY', 'required for the local field key provider');
    }
    if (env.LOCAL_FIELD_KEY && Buffer.from(env.LOCAL_FIELD_KEY, 'base64').length !== 32) {
      fail('LOCAL_FIELD_KEY', 'must be base64 of 32 bytes');
    }
    if (env.FIELD_KEY_PROVIDER === 'kms' && !env.KMS_KEY_ID) {
      fail('KMS_KEY_ID', 'required for the kms field key provider');
    }
    if (env.ESIGN_PROVIDER === 'zoho') {
      for (const key of [
        'ZOHO_SIGN_CLIENT_ID',
        'ZOHO_SIGN_CLIENT_SECRET',
        'ZOHO_SIGN_REFRESH_TOKEN',
      ] as const) {
        if (!env[key]) fail(key, 'required for Zoho Sign');
      }
    }
    if (env.NODE_ENV === 'production') {
      if (env.AUTH_MODE === 'dev')
        fail('ENTRA_TENANT_ID', 'dev sign-in is not allowed in production');
      if (env.FIELD_KEY_PROVIDER === 'local') {
        fail('FIELD_KEY_PROVIDER', 'the local key provider is not allowed in production');
      }
      if (env.STORAGE_PROVIDER === 'memory' || env.S3_ENDPOINT) {
        fail('STORAGE_PROVIDER', 'production documents must be in AWS S3');
      }
      if (env.ESIGN_PROVIDER === 'fake') {
        fail('ESIGN_PROVIDER', 'production letters must be signed through Zoho Sign');
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Parses environment variables; fails fast at startup with the names (never values) of bad settings. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(', ');
    throw new Error(`Invalid configuration: ${names}`);
  }
  return result.data;
}
