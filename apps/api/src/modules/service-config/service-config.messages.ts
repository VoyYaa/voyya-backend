export const SERVICE_CONFIG_MESSAGES = {
  serviceNotAvailable: 'Ese servicio no está disponible por ahora',
  municipalityNotFound: 'El municipio no existe',
  companyNotFound: 'La empresa no existe',
  fareNotFound: 'El municipio no tiene una tarifa vigente para este servicio',
  settingsConflict: 'Alguien más actualizó esta configuración mientras editabas',
  settingsOutOfRange: 'El valor está fuera del rango permitido',
  municipalityFareRequired: 'El municipio no tiene tarifa: indica la tarifa inicial',
  invalidData: 'Solicitud inválida',
  managedByPlatform: 'La tarifa y los parámetros los administra VoyYa para todo el municipio.',
} as const;
