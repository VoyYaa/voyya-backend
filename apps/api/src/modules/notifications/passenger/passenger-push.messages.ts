import type { PassengerPushNotificationType } from '@voyyaa/shared';

export interface PassengerPushCopy {
  readonly title: string;
  readonly body: string;
}

export const PASSENGER_PUSH_MESSAGES = {
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
} as const satisfies Record<PassengerPushNotificationType, PassengerPushCopy>;
