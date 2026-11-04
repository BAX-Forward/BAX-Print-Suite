/**
 * The JSON Schema (2020-12) subset used by BPP schemas, plus a small validator for it. Schemas are
 * the source of truth for other-language bindings; the validator keeps the SDK dependency-free.
 *
 * Supported keywords: type, properties, required, additionalProperties, items, enum, const,
 * pattern, minLength, maxLength, minimum, maximum, minItems, maxItems, minProperties, anyOf.
 * Annotation keywords ($id, $schema, title, description, default, format, examples) are ignored.
 * `$ref` is not resolved by the validator; it is used only in generated documents such as OpenAPI.
 * (`../cutter.ts` has the looser `JSONSchema` record type used for cut format options.)
 */

export type JsonType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

export interface JsonSchema {
  $id?: string;
  $schema?: string;
  $ref?: string;
  title?: string;
  description?: string;
  type?: JsonType | readonly JsonType[];
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: readonly unknown[];
  const?: unknown;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  anyOf?: readonly JsonSchema[];
  format?: string;
  default?: unknown;
  examples?: readonly unknown[];
}

export interface SchemaError {
  /** JSON Pointer to the failing value ("" for the root). */
  path: string;
  message: string;
}

function typeOf(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    default:
      return 'object';
  }
}

function matchesType(value: unknown, expected: JsonType): boolean {
  const actual = typeOf(value);
  return actual === expected || (expected === 'number' && actual === 'integer');
}

function pointer(path: string, key: string | number): string {
  return `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateInto(schema: JsonSchema, value: unknown, path: string, errors: SchemaError[]): void {
  if (schema.type !== undefined) {
    const types: readonly JsonType[] = typeof schema.type === 'string' ? [schema.type] : schema.type;
    if (!types.some((type) => matchesType(value, type))) {
      errors.push({ path, message: `must be ${types.join(' or ')}` });
      return;
    }
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => deepEqual(option, value))) {
    errors.push({
      path,
      message: `must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`,
    });
  }
  if (schema.anyOf !== undefined) {
    const matched = schema.anyOf.some((option) => validateSchema(option, value).length === 0);
    if (!matched) {
      errors.push({ path, message: 'must match at least one allowed schema' });
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `must have at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `must have at most ${schema.maxLength} characters` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push({ path, message: `must match pattern ${schema.pattern}` });
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `must have at least ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `must have at most ${schema.maxItems} items` });
    }
    if (schema.items !== undefined) {
      const itemSchema = schema.items;
      value.forEach((item, index) => validateInto(itemSchema, item, pointer(path, index), errors));
    }
  }
  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      errors.push({ path, message: `must have at least ${schema.minProperties} properties` });
    }
    for (const key of schema.required ?? []) {
      if (!(key in object) || object[key] === undefined) {
        errors.push({ path: pointer(path, key), message: 'is required' });
      }
    }
    const properties = schema.properties ?? {};
    for (const key of keys) {
      const propertySchema = properties[key];
      if (propertySchema !== undefined) {
        validateInto(propertySchema, object[key], pointer(path, key), errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: pointer(path, key), message: 'is not an allowed property' });
      } else if (typeof schema.additionalProperties === 'object') {
        validateInto(schema.additionalProperties, object[key], pointer(path, key), errors);
      }
    }
  }
}

/** Validates `value` against `schema`. Returns an empty array when valid. */
export function validateSchema(schema: JsonSchema, value: unknown): SchemaError[] {
  const errors: SchemaError[] = [];
  validateInto(schema, value, '', errors);
  return errors;
}

export function formatSchemaErrors(errors: readonly SchemaError[]): string[] {
  return errors.map((error) => `${error.path === '' ? '(root)' : error.path} ${error.message}`);
}
