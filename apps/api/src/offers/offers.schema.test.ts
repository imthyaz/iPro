import { bandCheckSchema, offerStatusSchema } from '@ipro/shared';
import { expect, it } from 'vitest';
import { bandChecks, offerStatuses } from './offers.schema.js';

it('database offer values match the shared lists', () => {
  expect([...offerStatuses]).toEqual(offerStatusSchema.options);
  expect([...bandChecks]).toEqual(bandCheckSchema.options);
});
