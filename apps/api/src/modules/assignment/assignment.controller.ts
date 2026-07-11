import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  AceptarAsignacionDTO,
  CancelarAsignacionConductorDTO,
  type OfertasCercanasRespuesta,
  RechazarAsignacionDTO,
  type ResultadoAceptacion,
  type ResultadoCancelacionConductor,
} from '@voyya/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentConductor, CurrentTenant } from '../tenancy/identity.decorators';
import { TenantGuard } from '../tenancy/tenant.guard';
import { AssignmentService } from './assignment.service';

/**
 * Endpoints del conductor sobre una asignación. Exigen JWT + rol `conductor`
 * (AuthGuard + RolesGuard globales) y tenant del JWT (TenantGuard). El estado HTTP
 * de `aceptar` refleja la toma única: aceptada → 200 · ya_tomada → 409 · expirada → 410.
 */
@Controller('assignments')
@Roles('conductor')
@UseGuards(TenantGuard)
export class AssignmentController {
  constructor(private readonly assignment: AssignmentService) {}

  /**
   * GET /assignments/cercanas — ofertas PENDIENTES del conductor autenticado.
   * PUENTE de polling que consume apps/driver hasta el PUSH real (EV1). Tenant del JWT.
   * TODO(EV1): complementar/reemplazar por push (Expo Notifications).
   */
  @Get('cercanas')
  listarCercanas(
    @CurrentTenant() idEmpresa: number,
    @CurrentConductor() idConductor: number,
  ): Promise<OfertasCercanasRespuesta> {
    return this.assignment.listarCercanas(idConductor, idEmpresa);
  }

  @Post(':id/aceptar')
  async aceptar(
    @Param('id', ParseIntPipe) idAsignacion: number,
    @Body(new ZodValidationPipe(AceptarAsignacionDTO)) dto: AceptarAsignacionDTO,
    @CurrentTenant() idEmpresa: number,
    @CurrentConductor() idConductor: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ResultadoAceptacion> {
    const r = await this.assignment.aceptar(idAsignacion, idConductor, idEmpresa, dto);
    res.status(r.resultado === 'aceptada' ? 200 : r.resultado === 'ya_tomada' ? 409 : 410);
    return r;
  }

  @Post(':id/rechazar')
  @HttpCode(200)
  rechazar(
    @Param('id', ParseIntPipe) idAsignacion: number,
    @Body(new ZodValidationPipe(RechazarAsignacionDTO)) dto: RechazarAsignacionDTO,
    @CurrentTenant() idEmpresa: number,
    @CurrentConductor() idConductor: number,
  ): Promise<{ ok: true }> {
    return this.assignment.rechazar(idAsignacion, idConductor, idEmpresa, dto);
  }

  @Post(':id/cancelar')
  @HttpCode(200)
  cancelar(
    @Param('id', ParseIntPipe) idAsignacion: number,
    @Body(new ZodValidationPipe(CancelarAsignacionConductorDTO))
    dto: CancelarAsignacionConductorDTO,
    @CurrentTenant() idEmpresa: number,
    @CurrentConductor() idConductor: number,
  ): Promise<ResultadoCancelacionConductor> {
    return this.assignment.cancelarPorConductor(idAsignacion, idConductor, idEmpresa, dto);
  }
}
