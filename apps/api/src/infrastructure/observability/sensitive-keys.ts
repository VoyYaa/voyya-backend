export const SENSITIVE_KEYS: readonly string[] = [
  'password',
  'password_hash',
  'pin',
  'current_pin',
  'new_pin',
  'otp',
  'otp_code',
  'otpCode',
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
  'lat',
  'lng',
  'current_lat',
  'current_lng',
  'start_code',
  'startCode',
  'driver_tracking',
  'position',
];

const SENSITIVE_KEY_SET: ReadonlySet<string> = new Set(
  SENSITIVE_KEYS.map((key) => key.toLowerCase()),
);

const MAX_DEPTH = 8;

export function redactSensitiveKeys(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) return value.map((item) => redactSensitiveKeys(item, depth + 1));
  if (value !== null && typeof value === 'object' && isPlain(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEY_SET.has(key.toLowerCase()) ? '[redacted]' : redactSensitiveKeys(item, depth + 1),
      ]),
    );
  }
  return value;
}

function isPlain(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
