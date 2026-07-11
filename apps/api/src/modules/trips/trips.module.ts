import { Module } from '@nestjs/common';
import { AssignmentModule } from '../assignment/assignment.module';
import { FestivosColombiaService } from './festivos/festivos-colombia.service';
import { FESTIVOS_PROVIDER } from './festivos/festivos.provider';
import { QuoteTokenService } from './quote-token.service';
import { TripsController } from './trips.controller';
import { TripsRepository } from './trips.repository';
import { TripsService } from './trips.service';

/** Dominio TRIPS: solicitud de taxi, tarifa fija, cancelación. */
@Module({
  // Importa AssignmentModule para leer el resumen del conductor asignado (P1.1).
  imports: [AssignmentModule],
  controllers: [TripsController],
  providers: [
    TripsService,
    TripsRepository,
    QuoteTokenService,
    // Festivos por PUERTO (DIP): hoy lista de config; mañana cálculo Ley Emiliani.
    { provide: FESTIVOS_PROVIDER, useClass: FestivosColombiaService },
  ],
  exports: [TripsService],
})
export class TripsModule {}
