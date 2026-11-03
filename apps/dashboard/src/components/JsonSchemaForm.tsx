import { useId, type ReactElement } from 'react';
import { strings } from '../strings';
import ui from './ui.module.css';

/**
 * Renders a device config form from a plugin manifest's `configSchema` (JSON Schema).
 * Supports flat objects with string, number/integer, boolean and enum properties, which is what
 * driver manifests use; other property types are shown as not editable.
 */

export interface JsonSchema {
  type?: string;
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  enum?: readonly (string | number | boolean)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export type ConfigValue = Record<string, unknown>;

export function asJsonSchema(value: unknown): JsonSchema | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonSchema) : null;
}

export function schemaDefaults(schema: JsonSchema): ConfigValue {
  const out: ConfigValue = {};
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (property.default !== undefined) out[key] = property.default;
  }
  return out;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/** Client-side checks mirroring the schema; the server validates again. Returns field → message. */
export function validateConfig(schema: JsonSchema, value: ConfigValue): Record<string, string> {
  const errors: Record<string, string> = {};
  const required = new Set(schema.required ?? []);
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const current = value[key];
    if (isEmpty(current)) {
      if (required.has(key)) errors[key] = strings.form.required;
      continue;
    }
    if (property.enum && !property.enum.some((option) => option === current)) {
      errors[key] = strings.form.choose;
    } else if (property.type === 'number' || property.type === 'integer') {
      if (typeof current !== 'number' || Number.isNaN(current)) errors[key] = strings.form.number;
      else if (property.type === 'integer' && !Number.isInteger(current)) errors[key] = strings.form.integer;
      else if (property.minimum !== undefined && current < property.minimum) errors[key] = strings.form.min(property.minimum);
      else if (property.maximum !== undefined && current > property.maximum) errors[key] = strings.form.max(property.maximum);
    }
  }
  return errors;
}

interface FormProps {
  schema: JsonSchema;
  value: ConfigValue;
  onChange: (value: ConfigValue) => void;
  errors?: Record<string, string>;
}

export function JsonSchemaForm({ schema, value, onChange, errors = {} }: FormProps) {
  const idPrefix = useId();
  const required = new Set(schema.required ?? []);
  return (
    <div className={ui.form}>
      {Object.entries(schema.properties ?? {}).map(([key, property]) => (
        <SchemaField
          key={key}
          id={`${idPrefix}-${key}`}
          name={key}
          schema={property}
          required={required.has(key)}
          value={value[key]}
          error={errors[key]}
          onChange={(next) => onChange({ ...value, [key]: next })}
        />
      ))}
    </div>
  );
}

interface FieldProps {
  id: string;
  name: string;
  schema: JsonSchema;
  required: boolean;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}

function SchemaField({ id, name, schema, required, value, error, onChange }: FieldProps) {
  const label = schema.title ?? name;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [schema.description ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  const shared = {
    id,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : undefined,
  } as const;
  const hint = schema.description ? (
    <p id={hintId} className={ui.hint}>
      {schema.description}
    </p>
  ) : null;
  const errorText = error ? (
    <p id={errorId} className={ui.error}>
      {error}
    </p>
  ) : null;

  if (schema.type === 'boolean') {
    return (
      <div className={ui.checkboxField}>
        <input {...shared} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        <label htmlFor={id}>{label}</label>
        {hint}
        {errorText}
      </div>
    );
  }

  let control: ReactElement;
  if (schema.enum) {
    const options = schema.enum;
    control = (
      <select
        {...shared}
        required={required}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(event) => onChange(options.find((option) => String(option) === event.target.value))}
      >
        {(!required || value === undefined) && <option value="">{strings.common.none}</option>}
        {options.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  } else if (schema.type === 'number' || schema.type === 'integer') {
    control = (
      <input
        {...shared}
        type="number"
        required={required}
        min={schema.minimum}
        max={schema.maximum}
        step={schema.type === 'integer' ? 1 : 'any'}
        value={typeof value === 'number' && !Number.isNaN(value) ? value : ''}
        onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
      />
    );
  } else if (schema.type === 'string' || schema.type === undefined) {
    control = (
      <input
        {...shared}
        type="text"
        required={required}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  } else {
    return (
      <div className={ui.field}>
        <span className={ui.fieldLabel}>{label}</span>
        <p className={ui.hint}>{strings.form.unsupported(schema.type)}</p>
      </div>
    );
  }

  return (
    <div className={ui.field}>
      <label htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {control}
      {hint}
      {errorText}
    </div>
  );
}
