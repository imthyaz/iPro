import type { INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { ACCESS_KEY, type RouteAccess } from '../src/authz/decorators.js';

export interface RouteInfo {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Full path with the global prefix, e.g. /api/leave/requests/:id/cancel. */
  path: string;
  controller: string;
  handler: string;
  access: RouteAccess | undefined;
}

const join = (...parts: (string | undefined)[]) =>
  '/' +
  parts
    .flatMap((p) => (p ?? '').split('/'))
    .filter(Boolean)
    .join('/');

/** Every HTTP route the app serves, read from the controllers' own metadata (slice 14a). */
export function listRoutes(app: INestApplication, prefix = 'api'): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const seen = new Set<unknown>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const type = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (!type || seen.has(type)) continue;
      seen.add(type);
      const base = Reflect.getMetadata(PATH_METADATA, type) as string | string[] | undefined;
      const classAccess = Reflect.getMetadata(ACCESS_KEY, type) as RouteAccess | undefined;
      for (const name of Object.getOwnPropertyNames(type.prototype)) {
        if (name === 'constructor') continue;
        const handler = (type.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (path === undefined || method === undefined) continue;
        const access =
          (Reflect.getMetadata(ACCESS_KEY, handler) as RouteAccess | undefined) ?? classAccess;
        for (const b of [base].flat()) {
          for (const p of [path].flat()) {
            routes.push({
              method: RequestMethod[method] as RouteInfo['method'],
              path: join(prefix, b, p),
              controller: type.name,
              handler: name,
              access,
            });
          }
        }
      }
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** A concrete URL for a route: path parameters become a well-formed id that matches nothing. */
export const concrete = (path: string) =>
  path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-00000000dead');
