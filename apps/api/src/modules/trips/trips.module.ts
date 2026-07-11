import { Module } from '@nestjs/common';
import { AssignmentModule } from '../assignment/assignment.module';
import { ColombiaHolidaysService } from './holidays/colombia-holidays.service';
import { HOLIDAYS_PROVIDER } from './holidays/holidays.provider';
import { QuoteTokenService } from './quote-token.service';
import { TripsController } from './trips.controller';
import { TripsRepository } from './trips.repository';
import { TripsService } from './trips.service';

@Module({
  imports: [AssignmentModule],
  controllers: [TripsController],
  providers: [
    TripsService,
    TripsRepository,
    QuoteTokenService,
    { provide: HOLIDAYS_PROVIDER, useClass: ColombiaHolidaysService },
  ],
  exports: [TripsService],
})
export class TripsModule {}
