import { Module } from '@nestjs/common';
import { EnvService } from '../../config/env.service';
import { PassengerPushLedger } from './passenger/passenger-push.ledger';
import { PassengerTripPushListener } from './passenger/passenger-trip-push.listener';
import { PUSH_TRANSPORT } from './ports/push-transport.port';
import { PushTokenController } from './push-token.controller';
import { PushTokenPurgeService } from './push-token-purge.service';
import { PushTokenRepository } from './push-token.repository';
import { createPushTransport } from './transport/push-transport.factory';

@Module({
  controllers: [PushTokenController],
  providers: [
    PushTokenRepository,
    PushTokenPurgeService,
    PassengerPushLedger,
    PassengerTripPushListener,
    { provide: PUSH_TRANSPORT, useFactory: createPushTransport, inject: [EnvService, PushTokenRepository] },
  ],
  exports: [PUSH_TRANSPORT],
})
export class NotificationsModule {}
