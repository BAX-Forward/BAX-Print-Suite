import type { ImportOptions, ReprintOptions } from '@bax-print/archive';
import { InvalidArgumentError } from '@bax-print/core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidArgumentError(`${key} must be a non-empty string`);
  }
  return value;
}

export function parseReprintBody(body: unknown): ReprintOptions {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) throw new InvalidArgumentError('reprint options must be a JSON object');
  const { copies, useCurrentHead } = body;
  if (copies !== undefined && (typeof copies !== 'number' || !Number.isInteger(copies))) {
    throw new InvalidArgumentError('copies must be an integer');
  }
  if (useCurrentHead !== undefined && typeof useCurrentHead !== 'boolean') {
    throw new InvalidArgumentError('useCurrentHead must be true or false');
  }
  return {
    copies,
    useCurrentHead,
    deviceId: optionalString(body, 'deviceId'),
    mediumId: optionalString(body, 'mediumId'),
    presetId: optionalString(body, 'presetId'),
    colorSetupRevisionId: optionalString(body, 'colorSetupRevisionId'),
  };
}

/** Reads `device.<originalId>=<localId>` and `medium.<originalId>=<localId>` query parameters. */
export function parseImportQuery(query: unknown): ImportOptions {
  if (!isRecord(query)) return {};
  const deviceMap: Record<string, string> = {};
  const mediumMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    const target = key.startsWith('device.') ? deviceMap : key.startsWith('medium.') ? mediumMap : undefined;
    if (!target) continue;
    const from = key.slice(key.indexOf('.') + 1);
    if (from === '' || typeof value !== 'string' || value.trim() === '') {
      throw new InvalidArgumentError(`${key} must map an original id to a local id`);
    }
    target[from] = value;
  }
  return { deviceMap, mediumMap };
}

export function parseLegalHoldBody(body: unknown): boolean {
  if (!isRecord(body) || typeof body.hold !== 'boolean') {
    throw new InvalidArgumentError('send {"hold": true} or {"hold": false}');
  }
  return body.hold;
}
