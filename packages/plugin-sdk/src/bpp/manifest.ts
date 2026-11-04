/**
 * Schema-based validation of `bps-plugin.json` (ARCHITECTURE.md §3.4). The stub's
 * `parseManifest` remains the typed parser; this reports every problem as a JSON Pointer.
 */
import { formatSchemaErrors, validateSchema, type SchemaError } from './json-schema.js';
import { isPlainObject } from './jsonrpc.js';
import { PLUGIN_MANIFEST_SCHEMA } from './schemas.js';
import { isValidRange } from './semver.js';

export class ManifestError extends Error {
  readonly errors: readonly SchemaError[];

  constructor(errors: readonly SchemaError[]) {
    super(`Invalid plugin manifest: ${formatSchemaErrors(errors).join('; ')}`);
    this.name = 'ManifestError';
    this.errors = errors;
  }
}

/** Returns every schema problem in `value`, plus invalid SemVer ranges in `provides`. */
export function validatePluginManifest(value: unknown): SchemaError[] {
  const errors = validateSchema(PLUGIN_MANIFEST_SCHEMA, value);
  if (isPlainObject(value) && Array.isArray(value.provides)) {
    value.provides.forEach((entry: unknown, index: number) => {
      if (
        isPlainObject(entry) &&
        typeof entry.versions === 'string' &&
        entry.versions.trim() !== '' &&
        !isValidRange(entry.versions)
      ) {
        errors.push({ path: `/provides/${index}/versions`, message: 'must be a valid SemVer range' });
      }
    });
  }
  return errors;
}

/** Throws a `ManifestError` listing all problems when `value` is not a valid manifest. */
export function assertPluginManifest(value: unknown): void {
  const errors = validatePluginManifest(value);
  if (errors.length > 0) {
    throw new ManifestError(errors);
  }
}
