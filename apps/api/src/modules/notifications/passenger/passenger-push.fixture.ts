import { ANDROID_TRIP_UPDATES_CHANNEL_ID, type PassengerPushNotificationType } from '@voyyaa/shared';
import type { PushMessage } from '../ports/push-transport.port';

export const SEEDED_TRIP_REQUEST_ID = 17;
export const SEEDED_TTL_SEC = 300;
export const SEEDED_REASON = 'zz-centinela-razon-8841';

export const SEEDED_IDS = {
  passengerId: 4529,
  driverId: 8806,
  assignmentId: 9034,
  companyId: 6358,
} as const;

export const UX_COPY: Readonly<Record<PassengerPushNotificationType, { title: string; body: string }>> = {
  trip_driver_assigned: {
    title: '¡Ya tienes conductor!',
    body: 'Un conductor aceptó tu viaje. Abre VoyYa para ver quién es.',
  },
  trip_driver_reassigned: {
    title: 'Tienes un conductor nuevo',
    body: 'Abre VoyYa y revisa tu viaje antes de subir.',
  },
  trip_driver_cancelled_searching: {
    title: 'Tu conductor canceló',
    body: 'Estamos buscando otro conductor para ti.',
  },
  trip_driver_cancelled_ended: {
    title: 'Tu conductor canceló el viaje',
    body: 'Ya no viene a recogerte. Abre VoyYa para pedir otro taxi.',
  },
  trip_driver_arrived: {
    title: 'Tu conductor indica que llegó',
    body: 'Ve al punto de encuentro. Abre VoyYa y confirma que es tu taxi.',
  },
  trip_no_driver: {
    title: 'No encontramos conductor',
    body: 'Ahora no hay conductores disponibles. Abre VoyYa para intentar de nuevo.',
  },
};

export const FORBIDDEN_PASSENGER_PUSH_CONTENT: readonly string[] = [
  '4821',
  'valeria',
  'restrepo',
  'marcelo',
  'quintero',
  '1017224455',
  '3105558899',
  '+573105558899',
  '3001234567',
  '+573001234567',
  'zkq-912',
  'zkq912',
  'chevrolet',
  'spark',
  'amarillo',
  'cootrayal',
  'cootrayal yarumal',
  'transportes del norte',
  '8000',
  '8.000',
  '$8.000',
  '350 m',
  '5 min',
  '12 min',
  'calle 50',
  '30-20',
  'el prado',
  'carrera 21',
  'barrio la esperanza',
  '6.9647',
  '6,9647',
  '6.964',
  '-75.4197',
  '-75,4197',
  '-75.419',
  '6.9702',
  '-75.4301',
  String(SEEDED_IDS.passengerId),
  String(SEEDED_IDS.driverId),
  String(SEEDED_IDS.assignmentId),
  String(SEEDED_IDS.companyId),
  'not_required',
  'not_applicable',
  'blocked',
  'active',
  'blocked_at',
  'attempts_remaining',
  'occurred_at',
  'arrived_at',
  'expires_at',
  '2026-10-13',
  SEEDED_REASON,
  'start_code',
  'passenger_id',
  'driver_id',
  'assignment_id',
  'company_id',
];

export function normalizeForSearch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function withoutLegitimateTripId(serialized: string, tripRequestId: number): string {
  const legitimateForms = new RegExp(
    `(trip-|"trip_request_id":|tripRequest=)${String(tripRequestId)}(?!\\d)`,
    'g',
  );
  return serialized.replace(legitimateForms, '$1#');
}

export function leakedTerms(
  serialized: string,
  tripRequestId: number = SEEDED_TRIP_REQUEST_ID,
): string[] {
  const haystack = normalizeForSearch(withoutLegitimateTripId(serialized, tripRequestId));
  const fourDigits = /\d{4}/.test(haystack) ? ['a sequence of four digits'] : [];
  return [
    ...FORBIDDEN_PASSENGER_PUSH_CONTENT.filter((term) => haystack.includes(normalizeForSearch(term))),
    ...fourDigits,
  ];
}

export function expectedPassengerPushMessage(
  type: PassengerPushNotificationType,
  tripRequestId: number = SEEDED_TRIP_REQUEST_ID,
  ttlSec: number = SEEDED_TTL_SEC,
): PushMessage {
  const copy = UX_COPY[type];
  return {
    title: copy.title,
    body: copy.body,
    data: { type, trip_request_id: tripRequestId },
    channelId: ANDROID_TRIP_UPDATES_CHANNEL_ID,
    ttlSec,
    priority: 'high',
    sound: 'default',
    replaceKey: `trip-${tripRequestId}`,
  };
}
