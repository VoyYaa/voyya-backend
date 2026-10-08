import { LOCATION_NOTICE_VERSION, type NoticeAudience } from './consent';

export const TRIP_COORDINATES_RETENTION_DAYS = 90;
export const DRIVER_LOCATION_RETENTION_MAX_HOURS = 13;

export const DATA_CONTROLLER = {
  legal_name: 'VoyYa S.A.S.',
  tax_id: 'en trámite',
  address: 'Calle 38B Sur # 45B-31',
  privacy_email: 'jhonnier98t@gmail.com',
  privacy_policy_url: 'https://www.voyya.website/privacy-policy',
} as const;

export interface NoticeRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

export interface LocationNotice {
  readonly version: string;
  readonly audience: NoticeAudience;
  readonly title: string;
  readonly rows: readonly NoticeRow[];
}

const controllerRow: NoticeRow = {
  key: 'controller',
  label: 'Quién trata tus datos',
  value: `${DATA_CONTROLLER.legal_name}, NIT ${DATA_CONTROLLER.tax_id}, con domicilio en ${DATA_CONTROLLER.address}, es el responsable de tus datos.`,
};

const rightsRow: NoticeRow = {
  key: 'rights',
  label: 'Tus derechos',
  value:
    'Puedes conocer, actualizar, rectificar y suprimir tus datos, revocar esta autorización, pedir prueba ' +
    `de que la diste y quejarte ante la Superintendencia de Industria y Comercio. Escríbenos a ${DATA_CONTROLLER.privacy_email}: ` +
    'respondemos consultas en máximo 10 días hábiles y reclamos en máximo 15 días hábiles.',
};

const moreRow: NoticeRow = {
  key: 'more',
  label: 'Más información',
  value: `Política de tratamiento de datos: ${DATA_CONTROLLER.privacy_policy_url}. Versión de este aviso: ${LOCATION_NOTICE_VERSION}.`,
};

const DRIVER_LOCATION_NOTICE: LocationNotice = {
  version: LOCATION_NOTICE_VERSION,
  audience: 'driver',
  title: 'Antes de activar tu turno',
  rows: [
    controllerRow,
    {
      key: 'data',
      label: 'Qué usamos',
      value:
        'La ubicación de tu teléfono, con una precisión de hasta 100 metros, solo mientras estás en turno y con ' +
        'la app abierta. No la seguimos en segundo plano.',
    },
    {
      key: 'purpose',
      label: 'Para qué',
      value:
        'Para ofrecerte primero los viajes más cercanos, calcular el tiempo de llegada que ve el pasajero y que ' +
        'tu empresa vea si tu ubicación está al día durante el turno.',
    },
    {
      key: 'optional',
      label: 'Si no la compartes',
      value: 'Compartirla es voluntario. Sin ella no puedes ponerte en turno ni recibir viajes.',
    },
    {
      key: 'sharing',
      label: 'Con quién se comparte',
      value:
        'Tu empresa afiliada solo ve si tu ubicación está al día, no dónde estás. El pasajero tampoco ve dónde ' +
        'estás: solo ve el tiempo estimado en que llegas. Nuestro proveedor de alojamiento (Railway) guarda los ' +
        'datos por cuenta nuestra, como explica la política.',
    },
    {
      key: 'retention',
      label: 'Cuánto la guardamos',
      value:
        'Guardamos solo tu última ubicación, no un historial. Se borra cuando cierras turno; si no lo cierras, ' +
        `se borra a más tardar ${DRIVER_LOCATION_RETENTION_MAX_HOURS} horas después de tu último reporte.`,
    },
    {
      key: 'withdrawal',
      label: 'Cómo dejas de compartirla',
      value:
        'En «Privacidad de mi ubicación», con «Dejar de compartir mi ubicación»: borramos tu última ubicación ' +
        'al instante y sales de turno. Si tienes un viaje en curso, el viaje sigue y sales de turno al terminarlo. ' +
        'Para volver a turno tendrás que aceptar este aviso otra vez. Si en cambio quitas el permiso en los ' +
        'ajustes del teléfono, dejamos de recibir tu ubicación y la que quedó guardada se borra a más tardar ' +
        `${DRIVER_LOCATION_RETENTION_MAX_HOURS} horas después de tu último reporte.`,
    },
    rightsRow,
    moreRow,
  ],
};

const PASSENGER_LOCATION_NOTICE: LocationNotice = {
  version: LOCATION_NOTICE_VERSION,
  audience: 'passenger',
  title: 'Antes de mostrar tu ubicación',
  rows: [
    controllerRow,
    {
      key: 'data',
      label: 'Qué usamos',
      value:
        'La ubicación de tu teléfono, con una precisión de hasta 100 metros, mientras la app está abierta, y los ' +
        'puntos de recogida y destino de cada viaje que pides. No la seguimos en segundo plano.',
    },
    {
      key: 'purpose',
      label: 'Para qué',
      value:
        'Para comprobar que estás dentro de la zona de servicio, ubicarte en el mapa, calcular tu tarifa y el ' +
        'tiempo estimado, y darle tu punto de recogida al conductor.',
    },
    {
      key: 'optional',
      label: 'Si no la compartes',
      value:
        'Compartirla es voluntario. Sin ella puedes pedir tu taxi marcando el punto de recogida en el mapa.',
    },
    {
      key: 'sharing',
      label: 'Con quién se comparte',
      value:
        'Los conductores a quienes se les ofrece tu viaje ven tu punto de recogida y el barrio de destino. El que ' +
        'lo acepta ve además tu destino y tu número de teléfono mientras dura el viaje. La empresa de taxis que ' +
        'atiende tu viaje también ve tus puntos de recogida y destino. Nuestro proveedor de alojamiento (Railway) ' +
        'guarda los datos por cuenta nuestra y Mapbox, que dibuja el mapa, puede recibir la zona que estás ' +
        'mirando (puede coincidir con tu ubicación), como explica la política.',
    },
    {
      key: 'retention',
      label: 'Cuánto la guardamos',
      value:
        'No guardamos la ubicación de tu teléfono por sí sola: guardamos los puntos de recogida y destino de cada ' +
        `viaje. Sus coordenadas exactas y direcciones se eliminan cuando el viaje cumple ${TRIP_COORDINATES_RETENTION_DAYS} ` +
        `días (el borrado corre una vez al día, así que a más tardar el día ${TRIP_COORDINATES_RETENTION_DAYS + 1}). ` +
        'El viaje, su tarifa y su comisión se conservan por obligaciones contables.',
    },
    {
      key: 'withdrawal',
      label: 'Cómo dejas de compartirla',
      value:
        'En «Privacidad de mi ubicación», con «Dejar de usar mi ubicación»: dejamos de leer tu GPS y marcarás tu ' +
        'punto de recogida en el mapa. Un viaje en curso sigue igual. Tus viajes anteriores no se borran por esto: ' +
        `sus coordenadas exactas se eliminan a los ${TRIP_COORDINATES_RETENTION_DAYS} días, y puedes pedir que se ` +
        'eliminen antes escribiendo al correo de este aviso. Para quitar también el permiso del sistema, hazlo en ' +
        'los ajustes de tu teléfono.',
    },
    rightsRow,
    moreRow,
  ],
};

export const LOCATION_NOTICES: Readonly<Record<NoticeAudience, LocationNotice>> = {
  driver: DRIVER_LOCATION_NOTICE,
  passenger: PASSENGER_LOCATION_NOTICE,
};

export function canonicalLocationNoticeText(audience: NoticeAudience): string {
  const notice = LOCATION_NOTICES[audience];
  const body = notice.rows.map((row) => `${row.label}\n${row.value}`);
  return [notice.version, notice.audience, notice.title, ...body].join('\n\n');
}

export function hasLegalPlaceholders(text: string): boolean {
  return /\[[A-ZÁÉÍÓÚÑ ]{3,}\]/.test(text);
}
