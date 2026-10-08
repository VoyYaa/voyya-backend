import {
  type ArgumentMetadata,
  BadRequestException,
  Injectable,
  type PipeTransform,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { SERVICE_CONFIG_MESSAGES } from './service-config.messages';

@Injectable()
export class ServiceConfigBodyPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    const crossField = result.error.issues.find((issue) => issue.code === 'custom');
    if (crossField) {
      throw new UnprocessableEntityException({
        code: 'SETTINGS_OUT_OF_RANGE',
        message: crossField.message,
        field: crossField.path.join('.'),
      });
    }
    throw new BadRequestException({
      code: 'INVALID_DATA',
      message: SERVICE_CONFIG_MESSAGES.invalidData,
      details: result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        error: issue.message,
      })),
    });
  }
}
