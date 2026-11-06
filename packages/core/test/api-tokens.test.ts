import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InvalidArgumentError,
  type Permission,
  issueApiToken,
  revokeApiToken,
  verifyApiToken,
} from "../src/index.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const LATER = new Date("2026-11-06T12:00:00.000Z");

function unknownScope(): Permission[] {
  const scopes: Permission[] = ["jobs:read"];
  Reflect.set(scopes, 0, "jobs:fly");
  return scopes;
}

describe("issueApiToken", () => {
  it("returns a bps_ secret and a record holding only its hash", () => {
    const { secret, record } = issueApiToken({ name: " CI bot ", scopes: ["jobs:read"], now: NOW });

    expect(secret).toMatch(/^bps_[A-Za-z0-9_-]{43}$/);
    expect(record.name).toBe("CI bot");
    expect(record.prefix).toBe(secret.slice(4, 12));
    expect(record.secretHash).toBe(createHash("sha256").update(secret).digest("hex"));
    expect(record.createdAt).toBe(NOW.toISOString());
    expect(record.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(record).not.toHaveProperty("expiresAt");
    expect(record).not.toHaveProperty("revokedAt");
  });

  it("never serializes the secret into the record", () => {
    const { secret, record } = issueApiToken({ name: "ci", scopes: ["jobs:read"], now: NOW });
    const json = JSON.stringify(record);

    expect(json).not.toContain(secret);
    expect(json).not.toContain(secret.slice(4));
    expect(Object.keys(record)).not.toContain("secret");
  });

  it("issues distinct secrets", () => {
    const a = issueApiToken({ name: "a", scopes: ["jobs:read"], now: NOW });
    const b = issueApiToken({ name: "b", scopes: ["jobs:read"], now: NOW });
    expect(a.secret).not.toBe(b.secret);
  });

  it("stores expiresAt as an ISO timestamp", () => {
    const { record } = issueApiToken({ name: "ci", scopes: ["jobs:read"], expiresAt: LATER, now: NOW });
    expect(record.expiresAt).toBe(LATER.toISOString());
  });

  it("sorts and dedupes scopes", () => {
    const { record } = issueApiToken({
      name: "ci",
      scopes: ["media:write", "jobs:read", "media:write", "archive:read"],
      now: NOW,
    });
    expect(record.scopes).toEqual(["archive:read", "jobs:read", "media:write"]);
  });

  it("rejects empty and unknown scopes", () => {
    expect(() => issueApiToken({ name: "ci", scopes: [], now: NOW })).toThrow(InvalidArgumentError);
    expect(() => issueApiToken({ name: "ci", scopes: unknownScope(), now: NOW })).toThrow(InvalidArgumentError);
  });

  it("rejects a blank name, an invalid now and a past expiry", () => {
    expect(() => issueApiToken({ name: "  ", scopes: ["jobs:read"], now: NOW })).toThrow(InvalidArgumentError);
    expect(() => issueApiToken({ name: "ci", scopes: ["jobs:read"], now: new Date(Number.NaN) })).toThrow(
      InvalidArgumentError,
    );
    expect(() => issueApiToken({ name: "ci", scopes: ["jobs:read"], expiresAt: NOW, now: NOW })).toThrow(
      InvalidArgumentError,
    );
  });
});

describe("verifyApiToken", () => {
  it("accepts the issued secret", () => {
    const { secret, record } = issueApiToken({ name: "ci", scopes: ["jobs:read"], now: NOW });
    expect(verifyApiToken(secret, record, NOW)).toEqual({ ok: true, record });
  });

  it("rejects a wrong secret", () => {
    const { record } = issueApiToken({ name: "ci", scopes: ["jobs:read"], now: NOW });
    const other = issueApiToken({ name: "other", scopes: ["jobs:read"], now: NOW });
    expect(verifyApiToken(other.secret, record, NOW)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("expires exactly at expiresAt", () => {
    const { secret, record } = issueApiToken({ name: "ci", scopes: ["jobs:read"], expiresAt: LATER, now: NOW });

    expect(verifyApiToken(secret, record, new Date(LATER.getTime() - 1)).ok).toBe(true);
    expect(verifyApiToken(secret, record, LATER)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a revoked token", () => {
    const { secret, record } = issueApiToken({ name: "ci", scopes: ["jobs:read"], now: NOW });
    const revoked = revokeApiToken(record, LATER);
    expect(verifyApiToken(secret, revoked, LATER)).toEqual({ ok: false, reason: "revoked" });
  });

  it("reports malformed input without throwing", () => {
    const { secret, record } = issueApiToken({ name: "ci", scopes: ["jobs:read"], now: NOW });
    const malformed: unknown[] = [
      undefined,
      null,
      42,
      "",
      "bps_",
      "xyz_" + secret.slice(4),
      secret + "A",
      secret.slice(0, -1) + "!",
    ];

    for (const input of malformed) {
      expect(verifyApiToken(input, record, NOW)).toEqual({ ok: false, reason: "malformed" });
    }
    expect(verifyApiToken(secret, { ...record, secretHash: "nothex" }, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyApiToken(secret, { ...record, expiresAt: "soon" }, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyApiToken(secret, record, new Date(Number.NaN))).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("revokeApiToken", () => {
  it("returns a revoked copy and leaves the original untouched", () => {
    const { record } = issueApiToken({ name: "ci", scopes: ["jobs:read"], now: NOW });
    const revoked = revokeApiToken(record, LATER);

    expect(revoked.revokedAt).toBe(LATER.toISOString());
    expect(record).not.toHaveProperty("revokedAt");
    expect(revokeApiToken(revoked, new Date("2027-01-01T00:00:00.000Z"))).toBe(revoked);
  });

  it("rejects an invalid now", () => {
    const { record } = issueApiToken({ name: "ci", scopes: ["jobs:read"], now: NOW });
    expect(() => revokeApiToken(record, new Date(Number.NaN))).toThrow(InvalidArgumentError);
  });
});
