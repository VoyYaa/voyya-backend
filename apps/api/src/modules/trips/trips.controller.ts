import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import {
  CancelarSolicitudDTO,
  type CotizacionRespuesta,
  CotizarTarifaDTO,
  CrearSolicitudDTO,
  type EstadoSolicitudViaje,
  type SolicitudCancelada,
  type SolicitudCreada,
} from '@voyya/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentPasajero } from '../tenancy/identity.decorators';
import { TripsService } from './trips.service';

/**
 * Endpoints del pasajero (entidad GLOBAL, sin tenant). Exigen JWT + rol `pasajero`
 * (AuthGuard + RolesGuard globales). Validación con esquemas Zod de `@voyya/shared`.
 */
@Controller('trips')
@Roles('pasajero')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  /** POST /trips/cotizar — tarifa fija ANTES de confirmar (HU-04). */
  @Post('cotizar')
  @HttpCode(200)
  cotizar(
    @Body(new ZodValidationPipe(CotizarTarifaDTO)) dto: CotizarTarifaDTO,
  ): Promise<CotizacionRespuesta> {
    return this.trips.cotizar(dto);
  }

  /** POST /trips — crear solicitud (cierra la tarifa) (HU-04). */
  @Post()
  crear(
    @Body(new ZodValidationPipe(CrearSolicitudDTO)) dto: CrearSolicitudDTO,
    @CurrentPasajero() idCliente: number,
  ): Promise<SolicitudCreada> {
    return this.trips.crear(dto, idCliente);
  }

  /** GET /trips/:id — estado del viaje para el pasajero dueño (P1.1). */
  @Get(':id')
  obtenerEstado(
    @Param('id', ParseIntPipe) idSolicitud: number,
    @CurrentPasajero() idCliente: number,
  ): Promise<EstadoSolicitudViaje> {
    return this.trips.obtenerEstado(idSolicitud, idCliente);
  }

  /** POST /trips/:id/cancelar — cancelación del pasajero (HU-05). */
  @Post(':id/cancelar')
  @HttpCode(200)
  cancelar(
    @Param('id', ParseIntPipe) idSolicitud: number,
    @Body(new ZodValidationPipe(CancelarSolicitudDTO)) dto: CancelarSolicitudDTO,
    @CurrentPasajero() idCliente: number,
  ): Promise<SolicitudCancelada> {
    return this.trips.cancelar(idSolicitud, idCliente, dto);
  }
}
