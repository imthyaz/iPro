import { existsSync, readFileSync } from 'node:fs';
import type { AppSettings } from './ipro-app.js';

/**
 * A stage's app settings (decision #100): infra/stages/<stage>.json (non-secret, committed) plus the
 * image tag from the deploy (`cdk deploy -c imageTag=<git sha>`). No image tag: the app isn't part of
 * the synth (data, keys and backups only). An image tag with settings still at REPLACE_ME: refused,
 * naming each one, so nothing half-configured is deployed.
 */
export function stageSettings(
  stage: string,
  imageTag: string | undefined,
  file = new URL(`../stages/${stage}.json`, import.meta.url),
): AppSettings | undefined {
  if (!imageTag) return undefined;
  if (!existsSync(file))
    throw new Error(`No settings for ${stage}: add infra/stages/${stage}.json`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Omit<AppSettings, 'imageTag'>;
  const unfilled = [
    ...(['domainName', 'certificateArn'] as const).filter((k) => raw[k] === 'REPLACE_ME'),
    ...Object.entries(raw.environment)
      .filter(([, v]) => v === 'REPLACE_ME')
      .map(([k]) => `environment.${k}`),
  ];
  if (unfilled.length > 0) {
    throw new Error(`infra/stages/${stage}.json still has REPLACE_ME: ${unfilled.join(', ')}`);
  }
  return { ...raw, imageTag };
}
