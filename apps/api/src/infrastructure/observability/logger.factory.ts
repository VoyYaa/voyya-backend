import pino, {
  type DestinationStream,
  type Logger as PinoLogger,
  type LoggerOptions,
} from 'pino';
import { redactPii, redactPiiDeep } from '@voyyaa/shared';
import { requestContext } from './request-context.service';
import { toSafeErrorFields } from './safe-error';
import { SENSITIVE_KEYS } from './sensitive-keys';

export interface LoggerFactoryConfig {
  level: string;
  service: string;
  env: string;
  release?: string;
}

const REQUEST_BODY_PATHS = ['body', '*.body', '*.*.body'];

const OTP_CODE_PATHS = ['otp.code', 'verification.code'];

function redactPaths(): string[] {
  const withWildcard = SENSITIVE_KEYS.map((key) => `*.${key}`);
  const otpWithWildcard = OTP_CODE_PATHS.map((path) => `*.${path}`);
  return [
    'req.headers.authorization',
    'req.headers.cookie',
    ...REQUEST_BODY_PATHS,
    ...OTP_CODE_PATHS,
    ...otpWithWildcard,
    ...withWildcard,
    ...SENSITIVE_KEYS,
  ];
}

function sanitizeArg(arg: unknown): unknown {
  if (typeof arg === 'string') return redactPii(arg);
  if (arg instanceof Error) return arg;
  if (arg !== null && typeof arg === 'object' && !Array.isArray(arg)) {
    const withSafeErrors = Object.fromEntries(
      Object.entries(arg).map(([key, value]) => [
        key,
        value instanceof Error ? toSafeErrorFields(value) : value,
      ]),
    );
    return redactPiiDeep(withSafeErrors);
  }
  return redactPiiDeep(arg);
}

export function buildLogger(
  config: LoggerFactoryConfig,
  destination?: DestinationStream,
): PinoLogger {
  const options: LoggerOptions = {
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
    serializers: {
      err: (error: unknown) => (error instanceof Error ? toSafeErrorFields(error) : error),
    },
    mixin() {
      return requestContext.get() ?? {};
    },
    hooks: {
      logMethod(inputArgs, method) {
        for (let i = 0; i < inputArgs.length; i += 1) {
          inputArgs[i] = sanitizeArg(inputArgs[i]);
        }
        return method.apply(this, inputArgs as Parameters<typeof method>);
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
