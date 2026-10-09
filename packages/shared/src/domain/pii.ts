const PHONE_CO = /(?:\+?57[\s.-]?)?\b3\d{2}[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const EXPO_PUSH_TOKEN = /ExponentPushToken\[[^\]]{1,64}\]/g;
const LABELLED_ID =
  /(?<![/.])\b(c[eé]dula|c\.?c\.?|documento|national_?id|nit|current_?pin|new_?pin|pin|otp|licencia|placa)(?![A-Za-z0-9_])(["']?\s*[:=#]\s*["']?|\s+)(?=[A-Za-z0-9.-]{0,19}\d)(\d{1,6}(?: \d{1,6}(?![A-Za-z0-9.-])){1,5}|[A-Za-z0-9.-]{3,20}(?: \d{1,6}(?![A-Za-z0-9.-])){0,5})/gi;
const PG_FAILING_ROW = /Failing row contains \((?:(?!\\n)[^\n])*/g;
const PG_KEY_VALUE =
  /Key \([^)\n]*\)=\((?:(?!\\n)[^\n])*?\)(?=\s+(?:already exists|is not present in|is still referenced from)|\.?(?:\\n|\n|$))/g;
const PG_DETAIL = /DETAIL:(?:(?!\\n)[^\n])*/g;

export function redactPii(input: string): string {
  return input
    .replace(PG_FAILING_ROW, 'Failing row contains ([redacted])')
    .replace(PG_KEY_VALUE, 'Key ([redacted])=([redacted])')
    .replace(PG_DETAIL, 'DETAIL: [redacted]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(JWT, '[jwt]')
    .replace(EXPO_PUSH_TOKEN, '[push-token]')
    .replace(EMAIL, '[email]')
    .replace(PHONE_CO, '[phone]')
    .replace(LABELLED_ID, (_m, label: string, sep: string) => `${label}${sep}[redacted]`);
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function errorToRecord(error: Error): Record<string, unknown> {
  return {
    ...(error as unknown as Record<string, unknown>),
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

export function redactPiiDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return redactPii(value);
  if (Array.isArray(value)) return value.map((v) => redactPiiDeep(v, depth + 1));
  if (value instanceof Error) return redactPiiDeep(errorToRecord(value), depth + 1);
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        redactPiiDeep(v, depth + 1),
      ]),
    );
  }
  return value;
}
