import { roles } from '@ipro/shared';
import { expect, it } from 'vitest';
import { roleValues } from './identity.schema.js';

it('database role enum matches the shared role list', () => {
  expect([...roleValues]).toEqual([...roles]);
});
