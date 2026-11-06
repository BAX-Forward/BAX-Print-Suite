import type { FastifyInstance } from 'fastify';
import {
  MarkSpecError,
  parseSwatchChartOptions,
  renderSwatchChart,
  type SwatchChartOptions,
  type SwatchCmykPercent,
  type SwatchColor,
  type SwatchLab,
  type SwatchLibrary,
} from '@bax-print/marks';
import { invalid } from './errors.js';
import { doc, SWATCH_CHART_MAX_COLORS, SWATCH_NAME_MAX_CHARS } from './openapi.js';

/** Spec 032b: `1` mounts `POST /swatch-charts`; unset leaves it off; any other value stops startup. */
export const SWATCH_CHARTS_ENV = 'BPS_SWATCH_CHARTS';

export function parseSwatchChartsFlag(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[SWATCH_CHARTS_ENV];
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${SWATCH_CHARTS_ENV} must be 1 or unset, got ${JSON.stringify(value)}`);
}

export interface SwatchChartRequest {
  readonly library: SwatchLibrary;
  readonly options: SwatchChartOptions;
}

const BODY_KEYS: ReadonlySet<string> = new Set(['library', 'options']);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkName(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value === 'string') {
    const length = [...value].length;
    if (length >= 1 && length <= SWATCH_NAME_MAX_CHARS) return value;
  }
  issues.push(`${path}: must be a string of 1 to ${SWATCH_NAME_MAX_CHARS} characters`);
  return undefined;
}

function checkLab(value: unknown, path: string, issues: string[]): SwatchLab | undefined {
  if (isRecord(value)) {
    const { L, a, b } = value;
    if (typeof L === 'number' && typeof a === 'number' && typeof b === 'number') return { L, a, b };
  }
  issues.push(`${path}: must be an object with the numbers L, a and b`);
  return undefined;
}

function checkCmyk(value: unknown, path: string, issues: string[]): SwatchCmykPercent | undefined {
  if (Array.isArray(value) && value.length === 4) {
    const [c, m, y, k]: readonly unknown[] = value;
    if (typeof c === 'number' && typeof m === 'number' && typeof y === 'number' && typeof k === 'number') return [c, m, y, k];
  }
  issues.push(`${path}: must be an array of 4 numbers (C, M, Y and K percent)`);
  return undefined;
}

/** A colour of the right shape, or `undefined` with the problems added to `issues`. */
function checkColor(value: unknown, path: string, issues: string[]): SwatchColor | undefined {
  if (!isRecord(value)) {
    issues.push(`${path}: must be an object`);
    return undefined;
  }
  const name = checkName(value.name, `${path}.name`, issues);
  const lab = checkLab(value.lab, `${path}.lab`, issues);
  const cmykFallback = value.cmykFallback === undefined ? undefined : checkCmyk(value.cmykFallback, `${path}.cmykFallback`, issues);
  if (name === undefined || lab === undefined) return undefined;
  return { name, lab, ...(cmykFallback === undefined ? {} : { cmykFallback }) };
}

function checkLibrary(value: unknown, issues: string[]): SwatchLibrary | undefined {
  if (!isRecord(value)) {
    issues.push('library: must be an object with a name and colors');
    return undefined;
  }
  const name = checkName(value.name, 'library.name', issues);
  const { colors } = value;
  if (!Array.isArray(colors)) {
    issues.push('library.colors: must be an array');
    return undefined;
  }
  const items: readonly unknown[] = colors;
  if (items.length > SWATCH_CHART_MAX_COLORS) {
    issues.push(`library.colors: at most ${SWATCH_CHART_MAX_COLORS} colors, got ${items.length}`);
    return undefined;
  }
  const checked = items.flatMap((item, index) => {
    const color = checkColor(item, `library.colors.${index}`, issues);
    return color === undefined ? [] : [color];
  });
  return name === undefined ? undefined : { name, colors: checked };
}

function parseOptions(input: unknown): SwatchChartOptions {
  try {
    return parseSwatchChartOptions(input);
  } catch (error) {
    if (error instanceof MarkSpecError) throw invalid(error.message, error.issues);
    throw error;
  }
}

/**
 * Spec 032b: checks the shape and the limits of a `POST /swatch-charts` body and the chart options;
 * throws a 400 `invalid_request` with the issues in `details`. The marks package checks the colour ranges.
 */
export function parseSwatchChartRequest(body: unknown): SwatchChartRequest {
  if (!isRecord(body)) throw invalid('Send a JSON object with a library and optional options');
  const issues = Object.keys(body)
    .filter((key) => !BODY_KEYS.has(key))
    .map((key) => `${key}: unknown field`);
  const library = checkLibrary(body.library, issues);
  if (library === undefined || issues.length > 0) throw invalid('invalid swatch chart request', issues);
  return { library, options: parseOptions(body.options) };
}

/** Anything the marks package rejects here is the library, e.g. a Lab value out of range: still the caller's 400. */
async function render(request: SwatchChartRequest): Promise<Uint8Array> {
  try {
    return await renderSwatchChart(request.library, request.options);
  } catch (error) {
    if (error instanceof MarkSpecError) throw invalid(error.message, error.issues);
    throw error;
  }
}

/** Spec 032b: `POST /swatch-charts` answers the Spec 032a swatch chart PDF of a spot library. */
export function registerSwatchChartRoutes(app: FastifyInstance): void {
  app.post<{ Body: unknown }>(
    '/swatch-charts',
    {
      schema: doc({
        operationId: 'renderSwatchChart',
        summary: 'Renders a printable swatch chart PDF with one Separation swatch per spot colour',
        tags: ['marks'],
        bodyDoc: { $ref: '#/components/schemas/SwatchChartRequest' },
        produces: 'application/pdf',
        responses: {
          200: 'The swatch chart PDF',
          400: `The body is not a valid swatch chart request, e.g. more than ${SWATCH_CHART_MAX_COLORS} colors, a value out of range or swatches that do not fit the page (\`invalid_request\`, issues in \`details\`)`,
        },
      }),
    },
    async (request, reply) => {
      const pdf = await render(parseSwatchChartRequest(request.body));
      return reply.header('content-type', 'application/pdf').send(Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength));
    },
  );
}
