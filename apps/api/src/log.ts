/**
 * pino logger. JSON lines in production (one object per request, keyed by `reqId`);
 * pretty-printed in development when pino-pretty (a dev dependency) is installed.
 */
import { createRequire } from 'node:module';
import pino, { type Logger } from 'pino';
import type { Config } from './config';

export type { Logger };

export function createLogger(config: Pick<Config, 'env' | 'logLevel'>): Logger {
  const options: pino.LoggerOptions = { level: config.logLevel, base: { svc: 'api' } };
  if (config.env === 'development' && hasPinoPretty()) {
    return pino({ ...options, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,svc', singleLine: true } } });
  }
  return pino(options);
}

function hasPinoPretty(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}
