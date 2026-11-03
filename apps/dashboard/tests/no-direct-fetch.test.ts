// @vitest-environment node
import { ESLint } from 'eslint';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Spec 002 Part B, rules: "A lint rule forbids `fetch` outside the generated client." The UI may
 * only reach the server through src/api/client.ts, which only knows endpoints from /openapi.json.
 */

const DASHBOARD_DIR = fileURLToPath(new URL('..', import.meta.url));
const NETWORK_RULES = new Set(['no-restricted-globals', 'no-restricted-properties', 'no-restricted-syntax']);
const LINT_TIMEOUT_MS = 60_000;

/** Inline `eslint-disable` comments are ignored, so nothing can opt out locally. */
const eslint = new ESLint({ cwd: DASHBOARD_DIR, allowInlineConfig: false });

async function networkViolations(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(DASHBOARD_DIR, file) });
  return result.messages.filter((message) => message.ruleId && NETWORK_RULES.has(message.ruleId)).map((message) => message.ruleId ?? '');
}

describe('no direct network access outside the API client', () => {
  it.each([
    ['a bare fetch call', "export const load = () => fetch('/jobs');", 'no-restricted-globals'],
    ['window.fetch', "export const load = () => window.fetch('/jobs');", 'no-restricted-properties'],
    ['globalThis.fetch', "export const load = () => globalThis.fetch('/jobs');", 'no-restricted-properties'],
    ['self.fetch in a worker', "export const load = () => self.fetch('/jobs');", 'no-restricted-properties'],
    ['XMLHttpRequest', 'export const request = () => new XMLHttpRequest();', 'no-restricted-syntax'],
  ])('rejects %s in UI code', async (_label, code, rule) => {
    expect(await networkViolations(code, 'src/pages/Example.tsx')).toContain(rule);
    expect(await networkViolations(code, 'src/preview/example.worker.ts')).toContain(rule);
  }, LINT_TIMEOUT_MS);

  it('allows fetch in the API client only', async () => {
    expect(await networkViolations("export const load = () => fetch('/jobs');", 'src/api/client.ts')).toEqual([]);
  }, LINT_TIMEOUT_MS);

  it('finds no direct network access anywhere in src/', async () => {
    const results = await eslint.lintFiles(['src']);
    expect(results.length).toBeGreaterThan(0);
    const offenders = results.flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId && NETWORK_RULES.has(message.ruleId))
        .map((message) => `${result.filePath}:${message.line} ${message.ruleId}`),
    );
    expect(offenders).toEqual([]);
  }, LINT_TIMEOUT_MS);
});
