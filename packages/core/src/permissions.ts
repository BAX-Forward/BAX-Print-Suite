import { type Actor, ForbiddenError } from './actor.js';
import { InvalidArgumentError } from './errors.js';

/**
 * Role-based permissions (spec 024a). Pure and deny by default: a role holds
 * only the permissions listed for it in ROLE_PERMISSIONS.
 */

/** Every permission, as `resource:action`, in sorted order. */
export const PERMISSIONS = Object.freeze([
  'archive:delete',
  'archive:read',
  'archive:write',
  'finishing:read',
  'finishing:write',
  'jobs:delete',
  'jobs:read',
  'jobs:write',
  'layouts:delete',
  'layouts:read',
  'layouts:write',
  'media:delete',
  'media:read',
  'media:write',
  'reports:read',
  'webhooks:delete',
  'webhooks:read',
  'webhooks:write',
] as const);

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = Object.freeze(['admin', 'designer', 'operator', 'viewer'] as const);

/** Roles known to the permission model; a superset of the actor `Role`. */
export type PermissionRole = (typeof ROLES)[number];

function permissionList(...permissions: Permission[]): readonly Permission[] {
  return Object.freeze(permissions);
}

/** Built-in role to permissions matrix. Each list is sorted. */
export const ROLE_PERMISSIONS: Readonly<Record<PermissionRole, readonly Permission[]>> = Object.freeze({
  admin: PERMISSIONS,
  designer: permissionList(
    'archive:read',
    'finishing:read',
    'jobs:read',
    'jobs:write',
    'layouts:delete',
    'layouts:read',
    'layouts:write',
    'media:read',
    'reports:read',
  ),
  operator: permissionList(
    'archive:read',
    'archive:write',
    'finishing:read',
    'finishing:write',
    'jobs:read',
    'jobs:write',
    'layouts:read',
    'layouts:write',
    'media:read',
    'media:write',
    'reports:read',
  ),
  viewer: permissionList(
    'archive:read',
    'finishing:read',
    'jobs:read',
    'layouts:read',
    'media:read',
    'reports:read',
  ),
});

const ROLE_SET: ReadonlySet<string> = new Set(ROLES);
const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isRole(value: unknown): value is PermissionRole {
  return typeof value === 'string' && ROLE_SET.has(value);
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

export function parseRole(value: unknown): PermissionRole {
  if (!isRole(value)) {
    throw new InvalidArgumentError(`unknown role: ${String(value)}`);
  }
  return value;
}

export function parsePermission(value: unknown): Permission {
  if (!isPermission(value)) {
    throw new InvalidArgumentError(`unknown permission: ${String(value)}`);
  }
  return value;
}

/** An actor, or the roles held by a caller. */
export type PermissionSubject = Actor | readonly PermissionRole[];

function isActor(subject: PermissionSubject): subject is Actor {
  return !Array.isArray(subject);
}

/** Roles of the subject, each validated so unknown roles fail loudly. */
function rolesOf(subject: PermissionSubject): readonly PermissionRole[] {
  const roles: readonly unknown[] = isActor(subject) ? [subject.role] : subject;
  return roles.map((role) => parseRole(role));
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Union of the permissions of every role, sorted and without duplicates. */
export function effectivePermissions(roles: readonly PermissionRole[]): Permission[] {
  const granted = new Set<Permission>();
  for (const role of rolesOf(roles)) {
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  return [...granted].sort(compareStrings);
}

/** True when any role of the subject grants the permission. No roles means no access. */
export function can(subject: PermissionSubject, permission: Permission): boolean {
  const wanted = parsePermission(permission);
  return rolesOf(subject).some((role) => ROLE_PERMISSIONS[role].includes(wanted));
}

export function requirePermission(subject: PermissionSubject, permission: Permission, action: string): void {
  if (!can(subject, permission)) {
    throw new ForbiddenError(action, { permission });
  }
}
