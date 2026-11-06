import { InvalidArgumentError } from './errors.js';

/** A message key such as `error.not_found`. */
export type MessageKey = string;

/** Messages of one locale, keyed by message key. */
export type Catalog = Readonly<Record<MessageKey, string>>;

/** Values substituted into `{name}` placeholders; plural placeholders need a number. */
export type MessageParams = Readonly<Record<string, string | number>>;

/** A parsed locale: the BCP 47 subset `language[-REGION]`, case-normalized. */
export interface Locale {
  /** Normalized tag, e.g. `en` or `pt-BR`. */
  readonly tag: string;
  /** Lowercase ISO 639 language subtag (2 or 3 letters). */
  readonly language: string;
  /** Uppercase ISO 3166 region or 3-digit UN M.49 area. */
  readonly region?: string;
}

const LOCALE_PATTERN = /^([a-z]{2,3})(?:-([a-z]{2}|[0-9]{3}))?$/i;

/** Parses `language[-region]`; anything else (scripts, variants, `_` separators) is rejected. */
export function parseLocale(input: string): Locale {
  const match = LOCALE_PATTERN.exec(input);
  const language = match?.[1]?.toLowerCase();
  if (match === null || language === undefined) {
    throw new InvalidArgumentError(`invalid locale ${JSON.stringify(input)}: expected language[-REGION], e.g. en or pt-BR`);
  }
  const region = match[2]?.toUpperCase();
  if (region === undefined) return Object.freeze({ tag: language, language });
  return Object.freeze({ tag: `${language}-${region}`, language, region });
}

export interface TranslatorOptions {
  /** Catalogs keyed by locale tag; tags are parsed and normalized. */
  readonly catalogs: Readonly<Record<string, Catalog>>;
  readonly defaultLocale: string;
}

export interface Translator {
  /** The normalized default locale tag. */
  readonly defaultLocale: string;
  /**
   * The message for `key`, looked up in `locale` (default: the default locale), then its
   * language, then the default locale and its language; the key itself if none has it.
   */
  t(key: MessageKey, params?: MessageParams, locale?: string): string;
  formatNumber(value: number | bigint, options?: Intl.NumberFormatOptions, locale?: string): string;
  formatDate(value: Date, options?: Intl.DateTimeFormatOptions, locale?: string): string;
}

/** The locale tags to try for `requested`, most specific first, without duplicates. */
function fallbackChain(requested: Locale, fallback: Locale): readonly string[] {
  const tags = [requested.tag, requested.language, fallback.tag, fallback.language];
  return tags.filter((tag, index) => tags.indexOf(tag) === index);
}

function lookup(catalog: Catalog, key: MessageKey): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(catalog, key)) return undefined;
  const message = catalog[key];
  return typeof message === 'string' ? message : undefined;
}

export function createTranslator(options: TranslatorOptions): Translator {
  const fallback = parseLocale(options.defaultLocale);
  const catalogs = new Map<string, Catalog>();
  for (const [tag, catalog] of Object.entries(options.catalogs)) {
    catalogs.set(parseLocale(tag).tag, catalog);
  }

  const resolve = (locale: string | undefined): Locale => (locale === undefined ? fallback : parseLocale(locale));

  return Object.freeze({
    defaultLocale: fallback.tag,
    t(key: MessageKey, params: MessageParams = {}, locale?: string): string {
      for (const tag of fallbackChain(resolve(locale), fallback)) {
        const catalog = catalogs.get(tag);
        const message = catalog === undefined ? undefined : lookup(catalog, key);
        if (message !== undefined) return formatMessage(message, params, tag);
      }
      return key;
    },
    formatNumber(value: number | bigint, numberOptions?: Intl.NumberFormatOptions, locale?: string): string {
      return new Intl.NumberFormat(resolve(locale).tag, numberOptions).format(value);
    },
    formatDate(value: Date, dateOptions?: Intl.DateTimeFormatOptions, locale?: string): string {
      if (Number.isNaN(value.getTime())) throw new InvalidArgumentError('cannot format an invalid date');
      return new Intl.DateTimeFormat(resolve(locale).tag, dateOptions).format(value);
    },
  });
}

/** Index of the `}` closing the `{` at `open`, or -1 when the braces are unbalanced. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const SIMPLE_PLACEHOLDER = /^\s*(\w+)\s*$/;
const PLURAL_PLACEHOLDER = /^\s*(\w+)\s*,\s*plural\s*,([\s\S]*)$/;
const PLURAL_SELECTOR = /^\s*(zero|one|two|few|many|other)\s*$/;

/** Parses `one {...} other {...}` into selector -> body; undefined when malformed or `other` is missing. */
function pluralOptions(text: string): ReadonlyMap<string, string> | undefined {
  const options = new Map<string, string>();
  let rest = text;
  while (rest.trim() !== '') {
    const open = rest.indexOf('{');
    const close = open < 0 ? -1 : closingBrace(rest, open);
    const selector = PLURAL_SELECTOR.exec(rest.slice(0, Math.max(open, 0)))?.[1];
    if (close < 0 || selector === undefined) return undefined;
    options.set(selector, rest.slice(open + 1, close));
    rest = rest.slice(close + 1);
  }
  return options.has('other') ? options : undefined;
}

function formatPlural(name: string, body: string, params: MessageParams, locale: string): string | undefined {
  const count = params[name];
  const options = pluralOptions(body);
  if (typeof count !== 'number' || !Number.isFinite(count) || options === undefined) return undefined;
  const branch = options.get(new Intl.PluralRules(locale).select(count)) ?? options.get('other') ?? '';
  const formatted = new Intl.NumberFormat(locale).format(count);
  return formatMessage(branch.split('#').join(formatted), params, locale);
}

/** One placeholder's text (without its braces); undefined leaves the placeholder as written. */
function formatPlaceholder(inner: string, params: MessageParams, locale: string): string | undefined {
  const simple = SIMPLE_PLACEHOLDER.exec(inner)?.[1];
  if (simple !== undefined) {
    const value = Object.prototype.hasOwnProperty.call(params, simple) ? params[simple] : undefined;
    return value === undefined ? undefined : String(value);
  }
  const plural = PLURAL_PLACEHOLDER.exec(inner);
  const name = plural?.[1];
  const body = plural?.[2];
  return name === undefined || body === undefined ? undefined : formatPlural(name, body, params, locale);
}

/**
 * Substitutes `{name}` and `{count, plural, one {...} other {...}}` placeholders (`#` in a branch
 * is the locale-formatted count). Missing params, unbalanced braces and unknown forms are left as
 * written; this never throws.
 */
export function formatMessage(message: string, params: MessageParams, locale: string): string {
  let output = '';
  let index = 0;
  while (index < message.length) {
    const open = message.indexOf('{', index);
    const close = open < 0 ? -1 : closingBrace(message, open);
    if (close < 0) return output + message.slice(index);
    const raw = message.slice(open, close + 1);
    output += message.slice(index, open) + (formatPlaceholder(raw.slice(1, -1), params, locale) ?? raw);
    index = close + 1;
  }
  return output;
}

/** English messages for the API error codes (`error.<code>`) the server answers with. */
export const API_ERROR_CATALOG_EN: Catalog = Object.freeze({
  'error.not_found': 'The requested resource was not found.',
  'error.invalid_request': 'The request is invalid.',
  'error.conflict': 'The request conflicts with the current state of the resource.',
  'error.forbidden': 'You do not have permission to perform this action.',
  'error.internal_error': 'An internal server error occurred.',
  'error.proof_watermark_invalid': 'The proof watermark options are invalid.',
  'error.report_range_invalid': 'The report date range is invalid.',
  'error.report_group_by_invalid': 'The report grouping is not supported.',
  'error.report_format_invalid': 'The report format is not supported.',
  'error.finishing_transition_invalid': 'The finishing step cannot change to the requested status.',
  'error.finishing_plan_invalid': 'The finishing plan is invalid.',
  'error.layout_template_invalid': 'The layout template is invalid.',
  'error.layout_template_name_exists': 'A layout template with this name already exists.',
});
