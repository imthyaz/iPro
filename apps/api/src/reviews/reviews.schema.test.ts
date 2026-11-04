import {
  checkInProgressSchema,
  reviewKindSchema,
  reviewOutcomeSchema,
  reviewStatusSchema,
} from '@ipro/shared';
import { expect, it } from 'vitest';
import {
  checkInProgresses,
  reviewKinds,
  reviewOutcomes,
  reviewStatuses,
} from './reviews.schema.js';

it('database review values match the shared lists', () => {
  expect([...reviewKinds]).toEqual(reviewKindSchema.options);
  expect([...reviewStatuses]).toEqual(reviewStatusSchema.options);
  expect([...reviewOutcomes]).toEqual(reviewOutcomeSchema.options);
  expect([...checkInProgresses]).toEqual(checkInProgressSchema.options);
});
