import pino, { type Logger as PinoLogger } from 'pino';
import { redactPii } from '@voyyaa/shared';
import { requestContext } from './request-context.service';

export interface LoggerFactoryConfig {
  level: string;
  service: string;
  env: string;
  release?: string;
}

const REDACT_KEYS = [
  'password',
  'password_hash',
  'pin',
  'otp',
  'code',
  'token',
  'phone',
  'contact_phone',
  'email',
  'contact_email',
  'national_id',
  'license',
  'plate',
  'address',
  'pickup_address',
  'dropoff_address',
  'first_name',
  'last_name',
];

function redactPaths(): string[] {
  const withWildcard = REDACT_KEYS.map((key) => `*.${key}`);
  return [
    'req.headers.authorization',
    'req.headers.cookie',
    ...withWildcard,
    ...REDACT_KEYS,
  ];
}

export function buildLogger(config: LoggerFactoryConfig): PinoLogger {
  return pino({
    level: config.level,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: config.service, env: config.env, release: config.release },
    redact: {
      paths: redactPaths(),
      censor: '[redacted]',
    },
    mixin() {
      return requestContext.get() ?? {};
    },
    hooks: {
      logMethod(inputArgs, method) {
        for (let i = 0; i < inputArgs.length; i += 1) {
          if (typeof inputArgs[i] === 'string') {
            inputArgs[i] = redactPii(inputArgs[i] as string);
          }
        }
        return method.apply(this, inputArgs as Parameters<typeof method>);
      },
    },
  });
}
