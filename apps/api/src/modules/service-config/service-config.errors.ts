import { ConflictException, NotFoundException } from '@nestjs/common';
import { SERVICE_CONFIG_MESSAGES } from './service-config.messages';
import type { ConflictInfo } from './service-config.types';

export function serviceNotAvailable(): ConflictException {
  return new ConflictException({
    code: 'SERVICE_NOT_AVAILABLE',
    message: SERVICE_CONFIG_MESSAGES.serviceNotAvailable,
  });
}

export function settingsConflict(info?: ConflictInfo): ConflictException {
  return new ConflictException({
    code: 'SETTINGS_CONFLICT',
    message: SERVICE_CONFIG_MESSAGES.settingsConflict,
    ...(info?.currentVersion != null ? { current_version: info.currentVersion } : {}),
    ...(info?.currentAuthorName != null ? { current_author_name: info.currentAuthorName } : {}),
  });
}

export function municipalityNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'MUNICIPALITY_NOT_FOUND',
    message: SERVICE_CONFIG_MESSAGES.municipalityNotFound,
  });
}

export function companyNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'COMPANY_NOT_FOUND',
    message: SERVICE_CONFIG_MESSAGES.companyNotFound,
  });
}

export function fareNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'FARE_NOT_FOUND',
    message: SERVICE_CONFIG_MESSAGES.fareNotFound,
  });
}

export function municipalityFareRequired(): ConflictException {
  return new ConflictException({
    code: 'MUNICIPALITY_FARE_REQUIRED',
    message: SERVICE_CONFIG_MESSAGES.municipalityFareRequired,
  });
}
