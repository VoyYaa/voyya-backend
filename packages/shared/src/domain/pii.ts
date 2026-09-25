const PHONE_CO = /(?:\+?57[\s.-]?)?\b3\d{2}[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const EXPO_PUSH_TOKEN = /ExponentPushToken\[[^\]]{1,64}\]/g;
const LABELLED_ID =
  /\b(c[eé]dula|cedula|documento|nit|pin|otp|licencia|placa)\b([\s:=#]{0,3})(\S{3,20})/gi;

export function redactPii(input: string): string {
  return input
    .replace(BEARER, 'Bearer [redacted]')
    .replace(JWT, '[jwt]')
    .replace(EXPO_PUSH_TOKEN, '[push-token]')
    .replace(EMAIL, '[email]')
    .replace(PHONE_CO, '[phone]')
    .replace(LABELLED_ID, (_m, label: string, sep: string) => `${label}${sep}[redacted]`);
}

export function redactPiiDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return redactPii(value);
  if (Array.isArray(value)) return value.map((v) => redactPiiDeep(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactPiiDeep(v, depth + 1)]),
    );
  }
  return value;
}
