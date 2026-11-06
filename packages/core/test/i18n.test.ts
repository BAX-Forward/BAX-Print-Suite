import { describe, expect, it } from 'vitest';
import { API_ERROR_CATALOG_EN, InvalidArgumentError, createTranslator, formatMessage, parseLocale } from '../src/index.js';

const ITEMS = '{count, plural, one {# item} other {# items}}';
const ITEMS_FR = '{count, plural, one {# article} other {# articles}}';

const translator = createTranslator({
  defaultLocale: 'en',
  catalogs: {
    en: { greeting: 'Hello, {name}.', items: ITEMS, onlyEnglish: 'English only', sun: 'sun' },
    fr: { greeting: 'Bonjour, {name} !', items: ITEMS_FR, sun: 'soleil' },
    'fr-ca': { sun: 'soleil du Québec' },
  },
});

describe('parseLocale', () => {
  it('normalizes language and region case', () => {
    expect(parseLocale('EN')).toEqual({ tag: 'en', language: 'en' });
    expect(parseLocale('pt-br')).toEqual({ tag: 'pt-BR', language: 'pt', region: 'BR' });
    expect(parseLocale('es-419')).toEqual({ tag: 'es-419', language: 'es', region: '419' });
    expect(Object.isFrozen(parseLocale('en-US'))).toBe(true);
  });

  it.each(['', 'e', 'english', 'en_US', 'en-', 'en-USA', 'zh-Hant-TW', ' en', 'en-1', '12'])('rejects %j', (input) => {
    expect(() => parseLocale(input)).toThrow(InvalidArgumentError);
  });

  it('rejects invalid locales in the translator', () => {
    expect(() => createTranslator({ defaultLocale: 'en_US', catalogs: {} })).toThrow(InvalidArgumentError);
    expect(() => createTranslator({ defaultLocale: 'en', catalogs: { 'not a locale': {} } })).toThrow(InvalidArgumentError);
    expect(() => translator.t('greeting', {}, 'xx_YY')).toThrow(InvalidArgumentError);
  });
});

describe('createTranslator fallback chain', () => {
  it('uses the region catalog first', () => {
    expect(translator.t('sun', {}, 'fr-CA')).toBe('soleil du Québec');
  });

  it('falls back from region to language', () => {
    expect(translator.t('greeting', { name: 'Ana' }, 'fr-CA')).toBe('Bonjour, Ana !');
    expect(translator.t('sun', {}, 'fr-FR')).toBe('soleil');
  });

  it('falls back to the default locale', () => {
    expect(translator.t('onlyEnglish', {}, 'fr-CA')).toBe('English only');
    expect(translator.t('greeting', { name: 'Ana' }, 'de')).toBe('Hello, Ana.');
    expect(translator.t('greeting', { name: 'Ana' })).toBe('Hello, Ana.');
  });

  it('falls back from a regional default locale to its language', () => {
    const regional = createTranslator({ defaultLocale: 'en-GB', catalogs: { en: { sun: 'sun' } } });
    expect(regional.defaultLocale).toBe('en-GB');
    expect(regional.t('sun', {}, 'de')).toBe('sun');
  });

  it('returns the key itself when no catalog has it', () => {
    expect(translator.t('missing.key', {}, 'fr-CA')).toBe('missing.key');
    expect(translator.t('toString')).toBe('toString');
  });
});

describe('placeholders', () => {
  it('substitutes string and number params', () => {
    expect(formatMessage('{a} and {b}', { a: 'x', b: 2 }, 'en')).toBe('x and 2');
  });

  it('leaves a missing param as written and never throws', () => {
    expect(translator.t('greeting')).toBe('Hello, {name}.');
    expect(formatMessage('{ name }', {}, 'en')).toBe('{ name }');
    expect(formatMessage('{toString}', {}, 'en')).toBe('{toString}');
  });

  it('leaves unbalanced braces and unknown forms as written', () => {
    expect(formatMessage('open { brace', { brace: 'x' }, 'en')).toBe('open { brace');
    expect(formatMessage('close } brace', {}, 'en')).toBe('close } brace');
    expect(formatMessage('{a, select, x {y} other {z}}', { a: 'x' }, 'en')).toBe('{a, select, x {y} other {z}}');
    expect(formatMessage('{n, plural, one {x}}', { n: 1 }, 'en')).toBe('{n, plural, one {x}}');
  });
});

describe('plural', () => {
  it('selects one and other in English', () => {
    expect(translator.t('items', { count: 1 })).toBe('1 item');
    expect(translator.t('items', { count: 0 })).toBe('0 items');
    expect(translator.t('items', { count: 1234 })).toBe('1,234 items');
  });

  it('selects one and other with French rules', () => {
    expect(translator.t('items', { count: 0 }, 'fr')).toBe('0 article');
    expect(translator.t('items', { count: 1 }, 'fr-CA')).toBe('1 article');
    expect(translator.t('items', { count: 2 }, 'fr')).toBe('2 articles');
  });

  it('falls back to other and substitutes params inside a branch', () => {
    const message = '{n, plural, one {{who} has # file} other {{who} has # files}}';
    expect(formatMessage(message, { n: 1, who: 'Ana' }, 'en')).toBe('Ana has 1 file');
    expect(formatMessage(message, { n: 3, who: 'Ana' }, 'pl')).toBe('Ana has 3 files');
  });

  it('leaves the placeholder when the count is missing or not a number', () => {
    expect(translator.t('items')).toBe(ITEMS);
    expect(translator.t('items', { count: 'two' })).toBe(ITEMS);
  });
});

describe('formatNumber and formatDate', () => {
  const date = new Date(Date.UTC(2026, 10, 5));

  it('format with the requested locale', () => {
    expect(translator.formatNumber(1234.5, {}, 'de-DE')).toBe('1.234,5');
    expect(translator.formatNumber(1234.5)).toBe('1,234.5');
    expect(translator.formatDate(date, { dateStyle: 'long', timeZone: 'UTC' })).toBe('November 5, 2026');
    expect(translator.formatDate(date, { dateStyle: 'long', timeZone: 'UTC' }, 'de')).toBe('5. November 2026');
  });

  it('rejects invalid input', () => {
    expect(() => translator.formatDate(new Date(Number.NaN))).toThrow(InvalidArgumentError);
    expect(() => translator.formatNumber(1, {}, 'de_DE')).toThrow(InvalidArgumentError);
  });
});

describe('API_ERROR_CATALOG_EN', () => {
  it('has a non-empty message for every entry', () => {
    const entries = Object.entries(API_ERROR_CATALOG_EN);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, message] of entries) {
      expect(key).toMatch(/^error\.[a-z_]+$/);
      expect(message.trim()).not.toBe('');
    }
  });

  it('is served by a translator', () => {
    const api = createTranslator({ defaultLocale: 'en', catalogs: { en: API_ERROR_CATALOG_EN } });
    expect(api.t('error.not_found', {}, 'fr')).toBe('The requested resource was not found.');
  });
});
