import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePrintOutputConfig, PRINTER_SETTINGS_MAX_FILE_BYTES } from '../src/print-output.js';

describe('BPS_PRINTER_SETTINGS (Spec 052a)', () => {
  let dir = '';
  let manifestPath = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bps-052a-settings-'));
    manifestPath = join(dir, 'bps-plugin.json');
    await writeFile(manifestPath, '{}');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const settingsOf = (value: string) =>
    parsePrintOutputConfig({ BPS_PRINT_OUTPUT: '1', BPS_PRINTER_PLUGIN: manifestPath, BPS_PRINTER_SETTINGS: value })?.settings;

  it('still takes inline JSON', () => {
    expect(settingsOf('{"outputDir":"/srv/out","copies":2}')).toEqual({ outputDir: '/srv/out', copies: 2 });
  });

  it('reads the JSON file an absolute path names', async () => {
    const path = join(dir, 'printer-settings.json');
    await writeFile(path, JSON.stringify({ outputDir: '/srv/out', token: 'secret' }));

    expect(settingsOf(path)).toEqual({ outputDir: '/srv/out', token: 'secret' });
  });

  it('turns the backslashes of a Windows outputDir into forward slashes, inline or from a file', async () => {
    const path = join(dir, 'windows.json');
    await writeFile(path, JSON.stringify({ outputDir: 'C:\\BPS\\out' }));

    expect(settingsOf(JSON.stringify({ outputDir: 'C:\\BPS\\out', note: 'a\\b' }))).toEqual({ outputDir: 'C:/BPS/out', note: 'a\\b' });
    expect(settingsOf(path)).toEqual({ outputDir: 'C:/BPS/out' });
  });

  it('stops startup for a relative path', () => {
    expect(() => settingsOf('settings/printer.json')).toThrow(/must be a JSON object or an absolute path/);
  });

  it('stops startup for a missing file or a directory', () => {
    expect(() => settingsOf(join(dir, 'missing.json'))).toThrow(/is not a readable file/);
    expect(() => settingsOf(dir)).toThrow(/is not a readable file/);
  });

  it('stops startup for a file above the size cap', async () => {
    const path = join(dir, 'large.json');
    await writeFile(path, `{"pad":"${'x'.repeat(PRINTER_SETTINGS_MAX_FILE_BYTES)}"}`);

    expect(() => settingsOf(path)).toThrow(/is larger than/);
  });

  it('stops startup for a file that is not a JSON object, without quoting it', async () => {
    const broken = join(dir, 'broken.json');
    const list = join(dir, 'list.json');
    await writeFile(broken, '{"token": "secret-value"');
    await writeFile(list, '[1, 2]');

    expect(() => settingsOf(broken)).toThrow(/^BPS_PRINTER_SETTINGS is not valid JSON$/);
    expect(() => settingsOf(list)).toThrow(/must be a JSON object/);
  });
});
