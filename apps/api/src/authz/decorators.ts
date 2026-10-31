import { SetMetadata } from '@nestjs/common';
import type { Action, DataArea } from './permissions.js';

export const ACCESS_KEY = 'ipro:access';

export type RouteAccess =
  | { kind: 'public' }
  | { kind: 'signed-in' }
  | { kind: 'authorize'; area: DataArea; action: Action }
  | { kind: 'authorize-any'; grants: readonly [DataArea, Action][] };

/** No session needed (health, sign-in). */
export const Public = () => SetMetadata(ACCESS_KEY, { kind: 'public' } satisfies RouteAccess);

/** Any signed-in user (about themselves: /me, sign-out). */
export const SignedIn = () => SetMetadata(ACCESS_KEY, { kind: 'signed-in' } satisfies RouteAccess);

/**
 * The actor must hold a grant for this action on this area. The service then checks the actual record
 * with `AuthzService.assert`. Routes without any of these decorators are denied.
 */
export const Authorize = (area: DataArea, action: Action) =>
  SetMetadata(ACCESS_KEY, { kind: 'authorize', area, action } satisfies RouteAccess);

/** Like Authorize, when any one of several grants opens the route (e.g. own KYC upload or HR update). */
export const AuthorizeAny = (...grants: [DataArea, Action][]) =>
  SetMetadata(ACCESS_KEY, { kind: 'authorize-any', grants } satisfies RouteAccess);
