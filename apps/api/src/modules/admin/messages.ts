export function driverCredentialsSms(pin: string): string {
  return `VoyYa · PIN ${pin}. Ingresa con tu número de cédula y este PIN.`;
}

export const DRIVER_HAS_ACTIVE_TRIP_MESSAGE =
  'El conductor tiene un viaje en curso. Espera a que termine para suspenderlo.';
