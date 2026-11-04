import { BPP_PROTOCOL } from '../stub.js';
import type { JsonSchema } from './json-schema.js';
import { INTERFACE_NAMES } from './protocol.js';

const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const SCHEMA_BASE = 'https://schemas.bax-print.org/bpp/1';

const SEMVER_PATTERN =
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$';

const nonEmptyString: JsonSchema = { type: 'string', minLength: 1 };

/** `bps-plugin.json` (ARCHITECTURE.md §3.4). Unknown fields are allowed and ignored (§3.6). */
export const PLUGIN_MANIFEST_SCHEMA: JsonSchema = {
  $schema: SCHEMA_DIALECT,
  $id: `${SCHEMA_BASE}/plugin-manifest.json`,
  title: 'BAX Print Suite plugin manifest',
  type: 'object',
  required: ['id', 'name', 'version', 'license', 'provides', 'protocol', 'exec'],
  properties: {
    id: {
      type: 'string',
      description: 'Reverse-DNS style identifier, e.g. "org.example.printer.sample".',
      pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*(?:\\.[a-z0-9]+(?:-[a-z0-9]+)*)+$',
      maxLength: 200,
    },
    name: nonEmptyString,
    version: { type: 'string', pattern: SEMVER_PATTERN },
    license: { ...nonEmptyString, description: 'SPDX license expression of the plugin itself.' },
    description: { type: 'string' },
    provides: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['interface', 'versions'],
        properties: {
          interface: { type: 'string', enum: INTERFACE_NAMES },
          versions: { ...nonEmptyString, description: 'SemVer range, e.g. ">=1.0 <2".' },
        },
      },
    },
    protocol: { type: 'string', const: BPP_PROTOCOL },
    exec: {
      type: 'object',
      required: ['command'],
      properties: {
        command: nonEmptyString,
        args: { type: 'array', items: { type: 'string' } },
        platforms: {
          type: 'array',
          items: { type: 'string', pattern: '^(win32|linux|darwin)-(x64|arm64|ia32|arm)$' },
        },
      },
    },
    externalDependencies: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'license'],
        properties: {
          name: nonEmptyString,
          license: nonEmptyString,
          userInstalled: { type: 'boolean' },
          detect: { type: 'string' },
        },
      },
    },
    permissions: {
      type: 'object',
      properties: {
        fs: { type: 'array', items: { type: 'string', pattern: '^(spool|input|output):(r|w|rw)$' } },
        network: { type: 'boolean' },
        devices: { type: 'array', items: { type: 'string' } },
      },
    },
    capabilities: { type: 'object' },
  },
};

const bandPlaneSchema: JsonSchema = {
  type: 'object',
  required: ['colorant', 'bitsPerSample', 'stride', 'offset'],
  properties: {
    colorant: nonEmptyString,
    bitsPerSample: { type: 'integer', enum: [1, 2, 4, 8, 16] },
    stride: { type: 'integer', minimum: 1 },
    offset: { type: 'integer', minimum: 0 },
  },
};

export const BAND_MESSAGE_SCHEMA: JsonSchema = {
  $schema: SCHEMA_DIALECT,
  $id: `${SCHEMA_BASE}/band-message.json`,
  title: 'Band message',
  type: 'object',
  required: ['bandId', 'y0', 'height', 'width', 'planes', 'handle'],
  properties: {
    bandId: nonEmptyString,
    y0: { type: 'integer', minimum: 0 },
    height: { type: 'integer', minimum: 1 },
    width: { type: 'integer', minimum: 1 },
    planes: { type: 'array', minItems: 1, items: bandPlaneSchema },
    handle: {
      type: 'object',
      required: ['transport', 'path', 'sizeBytes'],
      properties: {
        transport: { type: 'string', const: 'file' },
        path: nonEmptyString,
        sizeBytes: { type: 'integer', minimum: 0 },
      },
    },
  },
};

export const BAND_DATA_PARAMS_SCHEMA: JsonSchema = {
  $schema: SCHEMA_DIALECT,
  $id: `${SCHEMA_BASE}/band-data-params.json`,
  type: 'object',
  required: ['streamId', 'page', 'band', 'last'],
  properties: {
    streamId: nonEmptyString,
    page: { type: 'integer', minimum: 0 },
    band: BAND_MESSAGE_SCHEMA,
    last: { type: 'boolean' },
  },
};

const interfaceNameSchema: JsonSchema = { type: 'string', enum: INTERFACE_NAMES };

export const INITIALIZE_PARAMS_SCHEMA: JsonSchema = {
  $schema: SCHEMA_DIALECT,
  $id: `${SCHEMA_BASE}/initialize-params.json`,
  type: 'object',
  required: ['protocol', 'host', 'interfaces', 'spoolDir', 'capabilities'],
  properties: {
    protocol: { type: 'string', const: BPP_PROTOCOL },
    host: {
      type: 'object',
      required: ['name', 'version'],
      properties: { name: nonEmptyString, version: nonEmptyString },
    },
    interfaces: {
      type: 'array',
      items: {
        type: 'object',
        required: ['interface', 'versions'],
        properties: { interface: interfaceNameSchema, versions: nonEmptyString },
      },
    },
    spoolDir: nonEmptyString,
    capabilities: {
      type: 'object',
      required: ['transports'],
      properties: {
        transports: { type: 'array', items: { type: 'string', enum: ['file', 'shm'] } },
        maxInFlightBands: { type: 'integer', minimum: 1 },
      },
    },
  },
};

export const INITIALIZE_RESULT_SCHEMA: JsonSchema = {
  $schema: SCHEMA_DIALECT,
  $id: `${SCHEMA_BASE}/initialize-result.json`,
  type: 'object',
  required: ['protocol', 'plugin', 'interfaces', 'capabilities'],
  properties: {
    protocol: { type: 'string', const: BPP_PROTOCOL },
    plugin: {
      type: 'object',
      required: ['id', 'name', 'version'],
      properties: { id: nonEmptyString, name: nonEmptyString, version: nonEmptyString },
    },
    interfaces: {
      type: 'array',
      items: {
        type: 'object',
        required: ['interface', 'version'],
        properties: {
          interface: interfaceNameSchema,
          version: { type: 'string', pattern: SEMVER_PATTERN },
        },
      },
    },
    capabilities: { type: 'object' },
  },
};

/** All BPP v1 schemas, keyed by short name. Bindings for other languages are generated from these. */
export const BPP_SCHEMAS: Readonly<Record<string, JsonSchema>> = Object.freeze({
  pluginManifest: PLUGIN_MANIFEST_SCHEMA,
  bandMessage: BAND_MESSAGE_SCHEMA,
  bandDataParams: BAND_DATA_PARAMS_SCHEMA,
  initializeParams: INITIALIZE_PARAMS_SCHEMA,
  initializeResult: INITIALIZE_RESULT_SCHEMA,
});
