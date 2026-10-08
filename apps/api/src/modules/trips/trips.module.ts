import { Module } from '@nestjs/common';
import { AssignmentModule } from '../assignment/assignment.module';
import { ColombiaHolidaysService } from './holidays/colombia-holidays.service';
import { HOLIDAYS_PROVIDER } from './holidays/holidays.provider';
import { QuoteTokenService } from './quote-token.service';
import { TripCoordinatesPurgeService } from './trip-coordinates-purge.service';
import { TripServiceOptionsService } from './trip-service-options.service';
import { TripLifecycleController } from './trip-lifecycle.controller';
import { TripLifecycleService } from './trip-lifecycle.service';
import { TripsController } from './trips.controller';
import { TripsRepository } from './trips.repository';
import { TripsService } from './trips.service';

@Module({
  imports: [AssignmentModule],
  controllers: [TripsController, TripLifecycleController],
  providers: [
    TripsService,
    TripServiceOptionsService,
    TripsRepository,
    QuoteTokenService,
    TripLifecycleService,
    TripCoordinatesPurgeService,
    { provide: HOLIDAYS_PROVIDER, useClass: ColombiaHolidaysService },
  ],
  exports: [TripsService],
})
export class TripsModule {}
