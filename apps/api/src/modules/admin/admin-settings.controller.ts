import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { type ConsoleSettings, UpdateConsoleSettingsDTO } from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentTenant, CurrentUserId } from '../tenancy/identity.decorators';
import { TenantGuard } from '../tenancy/tenant.guard';
import { AdminSettingsService } from './admin-settings.service';

@Controller('admin/settings')
@Roles('admin')
@UseGuards(TenantGuard)
export class AdminSettingsController {
  constructor(private readonly service: AdminSettingsService) {}

  @Get()
  get(@CurrentTenant() companyId: number): Promise<ConsoleSettings> {
    return this.service.get(companyId);
  }

  @Put()
  update(
    @Body(new ZodValidationPipe(UpdateConsoleSettingsDTO)) dto: UpdateConsoleSettingsDTO,
    @CurrentTenant() companyId: number,
    @CurrentUserId() userId: number,
  ): Promise<ConsoleSettings> {
    return this.service.update(companyId, userId, dto);
  }
}
