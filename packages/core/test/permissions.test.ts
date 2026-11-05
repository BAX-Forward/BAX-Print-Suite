import { describe, expect, it } from "vitest";
import {
  type Actor,
  ForbiddenError,
  InvalidArgumentError,
  PERMISSIONS,
  type Permission,
  type PermissionRole,
  ROLES,
  ROLE_PERMISSIONS,
  can,
  effectivePermissions,
  parsePermission,
  parseRole,
  requirePermission,
} from "../src/index.js";

/** Simulates untrusted runtime data that bypassed the type system. */
function withUnknownRole(): PermissionRole[] {
  const roles: PermissionRole[] = ["viewer"];
  Reflect.set(roles, 0, "root");
  return roles;
}

function unknownPermission(): Permission {
  const input: { permission: Permission } = { permission: "jobs:read" };
  Reflect.set(input, "permission", "jobs:fly");
  return input.permission;
}

describe("permission catalogue", () => {
  it("lists every resource:action permission, sorted", () => {
    expect([...PERMISSIONS]).toEqual([
      "archive:delete",
      "archive:read",
      "archive:write",
      "finishing:read",
      "finishing:write",
      "jobs:delete",
      "jobs:read",
      "jobs:write",
      "layouts:delete",
      "layouts:read",
      "layouts:write",
      "media:delete",
      "media:read",
      "media:write",
      "reports:read",
      "webhooks:delete",
      "webhooks:read",
      "webhooks:write",
    ]);
  });

  it("lists the four built-in roles", () => {
    expect([...ROLES]).toEqual(["admin", "designer", "operator", "viewer"]);
  });
});

describe("ROLE_PERMISSIONS matrix", () => {
  it("grants admin every permission", () => {
    expect([...ROLE_PERMISSIONS.admin]).toEqual([...PERMISSIONS]);
  });

  it("grants operator production work but no deletes or webhooks", () => {
    expect([...ROLE_PERMISSIONS.operator]).toEqual([
      "archive:read",
      "archive:write",
      "finishing:read",
      "finishing:write",
      "jobs:read",
      "jobs:write",
      "layouts:read",
      "layouts:write",
      "media:read",
      "media:write",
      "reports:read",
    ]);
  });

  it("grants designer layout work and job edits", () => {
    expect([...ROLE_PERMISSIONS.designer]).toEqual([
      "archive:read",
      "finishing:read",
      "jobs:read",
      "jobs:write",
      "layouts:delete",
      "layouts:read",
      "layouts:write",
      "media:read",
      "reports:read",
    ]);
  });

  it("grants viewer read access only, without webhooks", () => {
    expect([...ROLE_PERMISSIONS.viewer]).toEqual([
      "archive:read",
      "finishing:read",
      "jobs:read",
      "layouts:read",
      "media:read",
      "reports:read",
    ]);
  });

  it("is frozen at every level", () => {
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(ROLES)).toBe(true);
    for (const role of ROLES) {
      expect(Object.isFrozen(ROLE_PERMISSIONS[role])).toBe(true);
    }
    expect(Reflect.set(ROLE_PERMISSIONS, "viewer", PERMISSIONS)).toBe(false);
    expect(ROLE_PERMISSIONS.viewer).not.toContain("jobs:delete");
  });
});

describe("can", () => {
  it("denies by default when no roles are held", () => {
    for (const permission of PERMISSIONS) {
      expect(can([], permission)).toBe(false);
    }
  });

  it("follows the matrix for each single role", () => {
    for (const role of ROLES) {
      for (const permission of PERMISSIONS) {
        expect(can([role], permission)).toBe(ROLE_PERMISSIONS[role].includes(permission));
      }
    }
  });

  it("accepts an actor", () => {
    const viewer: Actor = { id: "u1", role: "viewer" };
    const admin: Actor = { id: "u2", role: "admin" };
    expect(can(viewer, "jobs:read")).toBe(true);
    expect(can(viewer, "jobs:write")).toBe(false);
    expect(can(admin, "webhooks:delete")).toBe(true);
  });

  it("grants the union of multiple roles", () => {
    expect(can(["designer"], "finishing:write")).toBe(false);
    expect(can(["operator"], "layouts:delete")).toBe(false);
    expect(can(["designer", "operator"], "finishing:write")).toBe(true);
    expect(can(["designer", "operator"], "layouts:delete")).toBe(true);
    expect(can(["designer", "operator"], "jobs:delete")).toBe(false);
  });

  it("rejects unknown roles and permissions", () => {
    expect(() => can(withUnknownRole(), "jobs:read")).toThrow(InvalidArgumentError);
    expect(() => can(["admin"], unknownPermission())).toThrow(InvalidArgumentError);
    const actor: Actor = { id: "u3", role: "viewer" };
    Reflect.set(actor, "role", "root");
    expect(() => can(actor, "jobs:read")).toThrow(InvalidArgumentError);
  });
});

describe("requirePermission", () => {
  it("passes when the permission is granted", () => {
    expect(() => requirePermission(["operator"], "finishing:write", "record finishing step")).not.toThrow();
  });

  it("throws ForbiddenError naming the missing permission", () => {
    const viewer: Actor = { id: "u1", role: "viewer" };
    let caught: unknown;
    try {
      requirePermission(viewer, "jobs:delete", "delete job");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForbiddenError);
    expect(caught).toMatchObject({
      code: "FORBIDDEN",
      message: "delete job requires the jobs:delete permission",
      details: { permission: "jobs:delete" },
    });
  });

  it("throws ForbiddenError when no roles are held", () => {
    expect(() => requirePermission([], "reports:read", "read report")).toThrow(ForbiddenError);
  });

  it("rejects unknown permissions with InvalidArgumentError", () => {
    expect(() => requirePermission(["admin"], unknownPermission(), "fly")).toThrow(InvalidArgumentError);
  });
});

describe("effectivePermissions", () => {
  it("returns nothing for no roles", () => {
    expect(effectivePermissions([])).toEqual([]);
  });

  it("returns a sorted, de-duplicated union", () => {
    expect(effectivePermissions(["viewer", "designer", "viewer"])).toEqual([...ROLE_PERMISSIONS.designer]);
    expect(effectivePermissions(["operator", "designer"])).toEqual([
      "archive:read",
      "archive:write",
      "finishing:read",
      "finishing:write",
      "jobs:read",
      "jobs:write",
      "layouts:delete",
      "layouts:read",
      "layouts:write",
      "media:read",
      "media:write",
      "reports:read",
    ]);
    expect(effectivePermissions(["viewer", "admin"])).toEqual([...PERMISSIONS]);
  });

  it("returns a fresh array each call", () => {
    const first = effectivePermissions(["viewer"]);
    first.push("jobs:delete");
    expect(effectivePermissions(["viewer"])).not.toContain("jobs:delete");
  });

  it("rejects unknown roles", () => {
    expect(() => effectivePermissions(withUnknownRole())).toThrow(InvalidArgumentError);
  });
});

describe("parseRole and parsePermission", () => {
  it("accepts known values", () => {
    for (const role of ROLES) expect(parseRole(role)).toBe(role);
    for (const permission of PERMISSIONS) expect(parsePermission(permission)).toBe(permission);
  });

  it.each([["root"], ["Admin"], [""], [undefined], [42]])("rejects role %j", (value) => {
    expect(() => parseRole(value)).toThrow(InvalidArgumentError);
  });

  it.each([["jobs:fly"], ["JOBS:READ"], ["jobs"], ["reports:write"], [null]])("rejects permission %j", (value) => {
    expect(() => parsePermission(value)).toThrow(InvalidArgumentError);
  });
});
