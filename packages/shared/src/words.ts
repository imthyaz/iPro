/**
 * Display words and constants without zod (decision #97): `@ipro/shared/words`. Screens import values
 * from here so the schema library isn't part of their download; types still come from `@ipro/shared`.
 */
export * from './timeline-words.js';
