import { pino, type Logger, type LoggerOptions } from 'pino';
import { getContext } from './context';

export type { Logger } from 'pino';

/**
 * Paths that must never reach log output. Pino replaces them with "[REDACTED]".
 * Add to this list whenever a new secret-bearing field is introduced.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-internal-token"]',
  'req.headers["paypal-transmission-sig"]',
  'headers.authorization',
  'authorization',
  'accessToken',
  'access_token',
  'clientSecret',
  'client_secret',
  'apiKey',
  'password',
  '*.accessToken',
  '*.access_token',
  '*.apiKey',
  '*.dataBase64',
  'media.dataBase64',
];

export interface CreateLoggerOptions {
  name: string;
  level?: string;
  pretty?: boolean;
}

export function createLogger({
  name,
  level = 'info',
  pretty = false,
}: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    // Attach the active correlation ID to every log line automatically.
    mixin() {
      const ctx = getContext();
      return ctx ? { correlationId: ctx.correlationId, merchantId: ctx.merchantId } : {};
    },
  };
  if (pretty) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
    };
  }
  return pino(options);
}
