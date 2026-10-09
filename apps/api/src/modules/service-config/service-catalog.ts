import { Injectable } from '@nestjs/common';
import type { ActivatableServiceType, ServiceType } from '@voyyaa/shared';
import { EnvService } from '../../config/env.service';
import { serviceNotAvailable } from './service-config.errors';

@Injectable()
export class ServiceCatalog {
  constructor(private readonly env: EnvService) {}

  activeServiceTypes(): readonly ActivatableServiceType[] {
    return this.env.get('ACTIVE_SERVICE_TYPES');
  }

  isActive(serviceType: ServiceType): boolean {
    return this.activeServiceTypes().some((active) => active === serviceType);
  }

  assertActive(serviceType: ServiceType): void {
    if (!this.isActive(serviceType)) throw serviceNotAvailable();
  }

  assertAllActive(serviceTypes: readonly ServiceType[]): void {
    serviceTypes.forEach((serviceType) => this.assertActive(serviceType));
  }
}
