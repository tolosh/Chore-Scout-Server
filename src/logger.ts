import { pino, type Logger, type LoggerOptions } from 'pino'
import { SECRET_KEYS } from './config.js'

/** Header carrying the correlation id in and out of every request. */
export const CORRELATION_HEADER = 'x-correlation-id'

export function loggerOptions(level: string, gitSha: string): LoggerOptions {
  return {
    level,
    base: { service: 'chore-scout-server', gitSha },
    // Defence in depth: never log secrets or credentials even if they reach a log call.
    redact: {
      paths: [
        ...SECRET_KEYS,
        ...SECRET_KEYS.map((k) => `*.${k}`),
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
      ],
      censor: '[redacted]',
    },
  }
}

export function createLogger(level: string, gitSha: string): Logger {
  return pino(loggerOptions(level, gitSha))
}
