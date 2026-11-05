import { BpsError } from './errors.js';

export type Role = 'viewer' | 'operator' | 'admin';

export interface Actor {
  readonly id: string;
  readonly role: Role;
}

/** Actor used by schedulers and other unattended work. */
export const SYSTEM_ACTOR: Actor = { id: 'system', role: 'admin' };

const RANK: Readonly<Record<Role, number>> = { viewer: 0, operator: 1, admin: 2 };

export class ForbiddenError extends BpsError {
  /** `required` is a minimum role, or a named permission (spec 024a). */
  constructor(action: string, required: Role | { readonly permission: string }) {
    super(
      'FORBIDDEN',
      typeof required === 'string'
        ? `${action} requires the ${required} role`
        : `${action} requires the ${required.permission} permission`,
      typeof required === 'string' ? undefined : { details: { permission: required.permission } },
    );
  }
}

export function hasRole(actor: Actor, required: Role): boolean {
  return RANK[actor.role] >= RANK[required];
}

export function requireRole(actor: Actor, required: Role, action: string): void {
  if (!hasRole(actor, required)) {
    throw new ForbiddenError(action, required);
  }
}
