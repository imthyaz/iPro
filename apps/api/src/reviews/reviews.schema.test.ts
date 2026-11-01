import { probationOutcomeSchema, reviewKindSchema, reviewStatusSchema } from '@ipro/shared';
import { expect, it } from 'vitest';
import { probationOutcomes, reviewKinds, reviewStatuses } from './reviews.schema.js';

it('database review values match the shared lists', () => {
  expect([...reviewKinds]).toEqual(reviewKindSchema.options);
  expect([...reviewStatuses]).toEqual(reviewStatusSchema.options);
  expect([...probationOutcomes]).toEqual(probationOutcomeSchema.options);
});
