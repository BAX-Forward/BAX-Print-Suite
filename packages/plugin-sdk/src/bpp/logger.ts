/**
 * Plugin-side logging. Stdout carries the protocol, so plugin logs go to stderr as JSON lines,
 * which the host collects. Never pass settings or secrets as log fields.
 */

export type LogFields = Record<string, unknown>;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SdkLogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

export function createStderrLogger(
  name: string,
  minLevel: LogLevel = 'info',
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): SdkLogger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
        return;
      }
      const entry = { time: new Date().toISOString(), level, name, message, ...(fields ? { fields } : {}) };
      write(`${JSON.stringify(entry)}\n`);
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export const silentLogger: SdkLogger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});
