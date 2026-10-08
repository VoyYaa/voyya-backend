export function driverCredentialsSms(pin: string, ttlHours: number): string {
  const unit = ttlHours === 1 ? 'hora' : 'horas';
  return `VoyYa · PIN ${pin}. Ingresa con tu número de cédula y este PIN. Vence en ${ttlHours} ${unit}.`;
}

export const DRIVER_HAS_ACTIVE_TRIP_MESSAGE =
  'El conductor tiene un viaje en curso. Espera a que termine para suspenderlo.';
