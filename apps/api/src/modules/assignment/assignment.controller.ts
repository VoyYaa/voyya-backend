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
  AcceptAssignmentDTO,
  CancelAssignmentByDriverDTO,
  type CancelAssignmentByDriverResult,
  type NearbyOffersResponse,
  RejectAssignmentDTO,
  type AcceptAssignmentResult,
} from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentTenant, CurrentUserId } from '../tenancy/identity.decorators';
import { TenantGuard } from '../tenancy/tenant.guard';
import { AssignmentService } from './assignment.service';

@Controller('assignments')
@Roles('driver')
@UseGuards(TenantGuard)
export class AssignmentController {
  constructor(private readonly assignment: AssignmentService) {}

  @Get('nearby')
  listNearby(
    @CurrentTenant() companyId: number,
    @CurrentUserId() driverId: number,
  ): Promise<NearbyOffersResponse> {
    return this.assignment.listNearby(driverId, companyId);
  }

  @Post(':id/accept')
  async accept(
    @Param('id', ParseIntPipe) assignmentId: number,
    @Body(new ZodValidationPipe(AcceptAssignmentDTO)) dto: AcceptAssignmentDTO,
    @CurrentTenant() companyId: number,
    @CurrentUserId() driverId: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AcceptAssignmentResult> {
    const r = await this.assignment.accept(assignmentId, driverId, companyId, dto);
    res.status(r.result === 'accepted' ? 200 : r.result === 'already_taken' ? 409 : 410);
    return r;
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @Param('id', ParseIntPipe) assignmentId: number,
    @Body(new ZodValidationPipe(RejectAssignmentDTO)) dto: RejectAssignmentDTO,
    @CurrentTenant() companyId: number,
    @CurrentUserId() driverId: number,
  ): Promise<{ ok: true }> {
    return this.assignment.reject(assignmentId, driverId, companyId, dto);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', ParseIntPipe) assignmentId: number,
    @Body(new ZodValidationPipe(CancelAssignmentByDriverDTO))
    dto: CancelAssignmentByDriverDTO,
    @CurrentTenant() companyId: number,
    @CurrentUserId() driverId: number,
  ): Promise<CancelAssignmentByDriverResult> {
    return this.assignment.cancelByDriver(assignmentId, driverId, companyId, dto);
  }
}
