import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ASSIGNMENT_EVENTS,
  PUSH_NOTIFICATION_TYPES,
  TRIPS_EVENTS,
  type AssignmentCancelledByDriverEvent,
  type DriverAssignedEvent,
  type PassengerPushNotificationType,
  type TripRequestCancelledEvent,
  type TripRequestCompletedEvent,
  type TripRequestDriverArrivedEvent,
  type TripRequestNoDriverEvent,
  type TripRequestNoShowEvent,
} from '@voyyaa/shared';
import { EnvService } from '../../../config/env.service';
import { PUSH_TRANSPORT, type PushTransport } from '../ports/push-transport.port';
import { PassengerPushLedger } from './passenger-push.ledger';
import { toPassengerPushMessage } from './to-passenger-push-message';

interface PassengerTripFact {
  trip_request_id: number;
  passenger_id: number;
  occurred_at: string;
}

type DriverAssignedFact = Pick<DriverAssignedEvent, 'trip_request_id' | 'passenger_id' | 'occurred_at'>;

type DriverCancellationFact = Pick<
  AssignmentCancelledByDriverEvent,
  'trip_request_id' | 'passenger_id' | 'trip_request_status' | 'occurred_at'
>;

type DriverArrivedFact = Pick<
  TripRequestDriverArrivedEvent,
  'trip_request_id' | 'passenger_id' | 'occurred_at'
>;

type NoDriverFact = Pick<TripRequestNoDriverEvent, 'trip_request_id' | 'passenger_id' | 'occurred_at'>;

type TripClosedFact = Pick<
  TripRequestCancelledEvent | TripRequestCompletedEvent | TripRequestNoShowEvent,
  'trip_request_id'
>;

@Injectable()
export class PassengerTripPushListener {
  private readonly logger = new Logger(PassengerTripPushListener.name);

  constructor(
    private readonly env: EnvService,
    private readonly ledger: PassengerPushLedger,
    @Inject(PUSH_TRANSPORT) private readonly transport: PushTransport,
  ) {}

  @OnEvent(ASSIGNMENT_EVENTS.DRIVER_ASSIGNED, { async: true })
  async onDriverAssigned(fact: DriverAssignedFact): Promise<void> {
    const type = this.ledger.hadDriverCancellation(fact.trip_request_id)
      ? PUSH_NOTIFICATION_TYPES.TRIP_DRIVER_REASSIGNED
      : PUSH_NOTIFICATION_TYPES.TRIP_DRIVER_ASSIGNED;
    await this.notify(type, fact, false);
  }

  @OnEvent(ASSIGNMENT_EVENTS.ASSIGNMENT_CANCELLED_BY_DRIVER, { async: true })
  async onDriverCancelled(fact: DriverCancellationFact): Promise<void> {
    if (fact.trip_request_status === 'pending_assignment') {
      this.ledger.recordDriverCancellation(fact.trip_request_id);
      await this.notify(PUSH_NOTIFICATION_TYPES.TRIP_DRIVER_CANCELLED_SEARCHING, fact, false);
      return;
    }
    if (fact.trip_request_status === 'cancelled_by_driver') {
      await this.notify(PUSH_NOTIFICATION_TYPES.TRIP_DRIVER_CANCELLED_ENDED, fact, true);
    }
  }

  @OnEvent(TRIPS_EVENTS.TRIP_REQUEST_DRIVER_ARRIVED, { async: true })
  async onDriverArrived(fact: DriverArrivedFact): Promise<void> {
    await this.notify(PUSH_NOTIFICATION_TYPES.TRIP_DRIVER_ARRIVED, fact, false);
  }

  @OnEvent(TRIPS_EVENTS.TRIP_REQUEST_NO_DRIVER, { async: true })
  async onNoDriver(fact: NoDriverFact): Promise<void> {
    await this.notify(PUSH_NOTIFICATION_TYPES.TRIP_NO_DRIVER, fact, true);
  }

  @OnEvent(TRIPS_EVENTS.TRIP_REQUEST_CANCELLED)
  onTripCancelled(fact: TripClosedFact): void {
    this.ledger.forget(fact.trip_request_id);
  }

  @OnEvent(TRIPS_EVENTS.TRIP_REQUEST_COMPLETED)
  onTripCompleted(fact: TripClosedFact): void {
    this.ledger.forget(fact.trip_request_id);
  }

  @OnEvent(TRIPS_EVENTS.TRIP_REQUEST_NO_SHOW)
  onTripNoShow(fact: TripClosedFact): void {
    this.ledger.forget(fact.trip_request_id);
  }

  private async notify(
    type: PassengerPushNotificationType,
    fact: PassengerTripFact,
    closesTrip: boolean,
  ): Promise<void> {
    const tripRequestId = fact.trip_request_id;
    try {
      const delivery = this.ledger.submit(tripRequestId, () => this.deliver(type, fact));
      if (closesTrip) this.ledger.forget(tripRequestId);
      if (delivery === null) {
        this.logger.warn(`[push:passenger] capped tripRequest=${tripRequestId} type=${type}`);
        return;
      }
      await delivery;
    } catch {
      this.logger.error(`[push:passenger] failed tripRequest=${tripRequestId} type=${type}`);
    }
  }

  private async deliver(type: PassengerPushNotificationType, fact: PassengerTripFact): Promise<void> {
    const tripRequestId = fact.trip_request_id;
    try {
      await this.transport.send(
        fact.passenger_id,
        toPassengerPushMessage(type, tripRequestId, this.env.get('PASSENGER_PUSH_TTL_SEC')),
        {
          audience: 'passenger',
          tripRequestId,
          type,
          occurredAtMs: occurredAtMs(fact.occurred_at),
        },
      );
    } catch {
      this.logger.error(`[push:passenger] failed tripRequest=${tripRequestId} type=${type}`);
    }
  }
}

function occurredAtMs(occurredAt: string): number {
  const parsed = Date.parse(occurredAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
