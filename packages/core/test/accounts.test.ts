import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCRYPT_PARAMS,
  InvalidArgumentError,
  type PermissionRole,
  SCRYPT_N,
  type ScryptParams,
  type UserAccount,
  accountToActor,
  checkPasswordPolicy,
  createUserAccount,
  hashPassword,
  needsRehash,
  normalizeUsername,
  toPublicAccount,
  verifyPassword,
} from "../src/index.js";

/** Cheap scrypt cost so the suite stays fast; production uses DEFAULT_SCRYPT_PARAMS. */
const TEST_PARAMS: ScryptParams = { N: 16, r: 1, p: 1 };
const NOW = new Date("2026-11-05T10:00:00.000Z");
const PASSWORD = "correct horse battery";

async function testHash(password: string = PASSWORD): Promise<string> {
  return hashPassword(password, { params: TEST_PARAMS });
}

async function account(roles: readonly PermissionRole[], disabledAt?: Date): Promise<UserAccount> {
  const passwordHash = await testHash();
  return createUserAccount(
    disabledAt === undefined
      ? { username: "  Ana.Lopez ", displayName: " Ana López ", roles, passwordHash }
      : { username: "ana.lopez", displayName: "Ana López", roles, passwordHash, disabledAt },
    NOW,
  );
}

describe("normalizeUsername", () => {
  it("trims and lowercases", () => {
    expect(normalizeUsername("  Ops_Team-1.A ")).toBe("ops_team-1.a");
  });

  it("enforces length 3-64", () => {
    expect(normalizeUsername("abc")).toBe("abc");
    expect(normalizeUsername("a".repeat(64))).toHaveLength(64);
    expect(() => normalizeUsername("ab")).toThrow(InvalidArgumentError);
    expect(() => normalizeUsername("a".repeat(65))).toThrow(InvalidArgumentError);
  });

  it("rejects characters outside [a-z0-9._-]", () => {
    for (const name of ["ana lopez", "ana@lab", "ñandú", "ana/../x"]) {
      expect(() => normalizeUsername(name)).toThrow(InvalidArgumentError);
    }
    expect(() => normalizeUsername(42)).toThrow(InvalidArgumentError);
  });
});

describe("createUserAccount", () => {
  it("normalizes fields and stamps id and createdAt", async () => {
    const created = await account(["viewer", "operator", "viewer"]);
    expect(created.username).toBe("ana.lopez");
    expect(created.displayName).toBe("Ana López");
    expect(created.roles).toEqual(["operator", "viewer"]);
    expect(created.createdAt).toBe("2026-11-05T10:00:00.000Z");
    expect(created.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(created.disabledAt).toBeUndefined();
    expect("disabledAt" in created).toBe(false);
    expect(Object.isFrozen(created)).toBe(true);
  });

  it("records disabledAt", async () => {
    const created = await account(["viewer"], new Date("2026-11-06T00:00:00.000Z"));
    expect(created.disabledAt).toBe("2026-11-06T00:00:00.000Z");
  });

  it("requires at least one known role", async () => {
    const passwordHash = await testHash();
    const input = { username: "ana", displayName: "Ana", passwordHash };
    expect(() => createUserAccount({ ...input, roles: [] }, NOW)).toThrow(InvalidArgumentError);
    const roles: PermissionRole[] = ["viewer"];
    Reflect.set(roles, 0, "root");
    expect(() => createUserAccount({ ...input, roles }, NOW)).toThrow(InvalidArgumentError);
  });

  it("rejects an empty display name, a bad date and a non-hash password", async () => {
    const passwordHash = await testHash();
    const input = { username: "ana", displayName: "Ana", roles: ["viewer"] as const, passwordHash };
    expect(() => createUserAccount({ ...input, displayName: "   " }, NOW)).toThrow(InvalidArgumentError);
    expect(() => createUserAccount({ ...input, displayName: "x".repeat(129) }, NOW)).toThrow(
      InvalidArgumentError,
    );
    expect(() => createUserAccount(input, new Date(Number.NaN))).toThrow(InvalidArgumentError);
    expect(() => createUserAccount({ ...input, passwordHash: PASSWORD }, NOW)).toThrow(InvalidArgumentError);
  });
});

describe("toPublicAccount", () => {
  it("omits the password hash", async () => {
    const created = await account(["admin"], new Date("2026-11-06T00:00:00.000Z"));
    const publicAccount = toPublicAccount(created);
    expect("passwordHash" in publicAccount).toBe(false);
    expect(JSON.stringify(publicAccount)).not.toContain("scrypt");
    expect(publicAccount).toEqual({
      id: created.id,
      username: "ana.lopez",
      displayName: "Ana López",
      roles: ["admin"],
      createdAt: created.createdAt,
      disabledAt: "2026-11-06T00:00:00.000Z",
    });
  });
});

describe("checkPasswordPolicy", () => {
  it("accepts 12-256 characters", () => {
    expect(checkPasswordPolicy("a".repeat(12))).toEqual({ ok: true, reasons: [] });
    expect(checkPasswordPolicy("a".repeat(256)).ok).toBe(true);
  });

  it("reports too short and too long", () => {
    expect(checkPasswordPolicy("a".repeat(11)).reasons).toEqual(["too_short"]);
    expect(checkPasswordPolicy("a".repeat(257)).reasons).toEqual(["too_long"]);
  });

  it("counts code points, not UTF-16 units", () => {
    expect(checkPasswordPolicy("🔒".repeat(11)).reasons).toEqual(["too_short"]);
  });

  it("rejects a password equal to the username, ignoring case", () => {
    expect(checkPasswordPolicy("Operator.Team", "operator.team").reasons).toEqual(["matches_username"]);
    expect(checkPasswordPolicy("ana", "ana").reasons).toEqual(["too_short", "matches_username"]);
    expect(checkPasswordPolicy("operator.team?", "operator.team").ok).toBe(true);
  });
});

describe("hashPassword and verifyPassword", () => {
  it("encodes scrypt$N$r$p$salt$hash in base64url", async () => {
    const encoded = await testHash();
    expect(encoded).toMatch(/^scrypt\$16\$1\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  });

  it("uses a random salt per hash", async () => {
    expect(await testHash()).not.toBe(await testHash());
  });

  it("verifies the right password and rejects others", async () => {
    const encoded = await testHash();
    expect(await verifyPassword(PASSWORD, encoded)).toBe(true);
    expect(await verifyPassword("correct horse battery?", encoded)).toBe(false);
    expect(await verifyPassword("", encoded)).toBe(false);
  });

  it("defaults to N=2^15, r=8, p=1", () => {
    expect(SCRYPT_N).toBe(2 ** 15);
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({ N: 32768, r: 8, p: 1 });
  });

  it("rejects an empty password and invalid parameters", async () => {
    await expect(hashPassword("", { params: TEST_PARAMS })).rejects.toThrow(InvalidArgumentError);
    await expect(hashPassword(PASSWORD, { params: { N: 15, r: 1, p: 1 } })).rejects.toThrow(
      InvalidArgumentError,
    );
    await expect(hashPassword(PASSWORD, { params: { N: 16, r: 0, p: 1 } })).rejects.toThrow(
      InvalidArgumentError,
    );
  });

  it("returns false for malformed input instead of throwing", async () => {
    const encoded = await testHash();
    const [, , , , salt = "", key = ""] = encoded.split("$");
    const malformed: unknown[] = [
      undefined,
      null,
      42,
      "",
      "scrypt",
      encoded.replace("scrypt$", "bcrypt$"),
      `${encoded}$extra`,
      `scrypt$15$1$1$${salt}$${key}`,
      `scrypt$016$1$1$${salt}$${key}`,
      `scrypt$16$0$1$${salt}$${key}`,
      `scrypt$${2 ** 30}$1$1$${salt}$${key}`,
      `scrypt$16$1$1$${salt}$${key.slice(0, 4)}`,
      `scrypt$16$1$1$${salt}$${key}=`,
      `scrypt$16$1$1$${salt}$${key.replace(/.$/, "+")}`,
    ];
    for (const value of malformed) {
      await expect(verifyPassword(PASSWORD, value)).resolves.toBe(false);
    }
    await expect(verifyPassword(undefined, encoded)).resolves.toBe(false);
  });
});

describe("needsRehash", () => {
  it("is false only for hashes made with the given parameters", async () => {
    const encoded = await testHash();
    expect(needsRehash(encoded, TEST_PARAMS)).toBe(false);
    expect(needsRehash(encoded)).toBe(true);
    expect(needsRehash(encoded, { ...TEST_PARAMS, N: 32 })).toBe(true);
  });

  it("is true for malformed input", () => {
    expect(needsRehash("not a hash")).toBe(true);
    expect(needsRehash(undefined)).toBe(true);
  });
});

describe("accountToActor", () => {
  it("uses the highest mapped role", async () => {
    const admin = await account(["viewer", "admin"]);
    expect(accountToActor(admin)).toEqual({ id: admin.id, role: "admin" });
    expect(accountToActor(await account(["operator", "viewer"])).role).toBe("operator");
    expect(accountToActor(await account(["viewer"])).role).toBe("viewer");
  });

  it("maps designer to viewer so it gains no operator writes", async () => {
    expect(accountToActor(await account(["designer"])).role).toBe("viewer");
    expect(accountToActor(await account(["designer", "operator"])).role).toBe("operator");
  });

  it("keeps the account id and refuses disabled accounts", async () => {
    const created = await account(["operator"]);
    expect(accountToActor(created).id).toBe(created.id);
    const disabled = await account(["operator"], NOW);
    expect(() => accountToActor(disabled)).toThrow(InvalidArgumentError);
  });
});
