export const TRIPS_MESSAGES = {
  noCompanyAvailable: 'No hay ninguna empresa prestando el servicio en este municipio',
  fareNotConfigured: 'No hay tarifa vigente para este municipio/servicio',
  quoteExpired: 'La cotización venció, vuelve a cotizar',
  quoteInvalid: 'quote_token inválido',
  quoteMismatch: 'La cotización no corresponde a la solicitud enviada',
  companyNotAvailable: 'Esa empresa no está disponible ahora. Elige otra o «Cualquiera».',
  outOfCoverage: 'El origen o el destino está fuera del área de cobertura',
  tripNotFound: 'La solicitud no existe',
  notOwner: 'No eres el dueño',
  notCancellable: 'La solicitud ya no se puede cancelar',
  activeTripExists: 'Ya tienes un viaje en curso',
  notAssignedDriver: 'No eres el conductor asignado a este viaje',
  tripAlreadyClosed: 'No puedes hacer esta transición: el viaje ya está cerrado',
  arrivalNotMarked: 'Primero marca tu llegada al punto de recogida',
  noShowGracePending: 'Aún no pasa la cortesía de espera',
  invalidTransition: (status: string): string =>
    `No puedes hacer esta transición: el viaje está en ${status}`,
  startCodeRequired:
    'Para iniciar este viaje pídele el código al pasajero y actualiza la app de conductor',
  startCodeInvalid: (attemptsRemaining: number): string =>
    attemptsRemaining === 1
      ? 'Código incorrecto. Último intento.'
      : `Código incorrecto. Te quedan ${attemptsRemaining} intentos.`,
  startCodeBlocked:
    'El inicio de este viaje quedó bloqueado. Llama al pasajero, declara que no se presentó o cancela el viaje.',
  cannotMarkArrival: (status: string): string => `No puedes marcar la llegada: el viaje está en ${status}`,
  cannotConfirmCash: (status: string): string => `No puedes confirmar el cobro: el viaje está en ${status}`,
} as const;
