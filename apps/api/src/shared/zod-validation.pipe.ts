import {
  type ArgumentMetadata,
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { ZodSchema } from 'zod';

/**
 * Pipe de validación con Zod. Reusa los esquemas de `@voyya/shared` (DRY: mismos
 * contratos back + front). Sustituye a class-validator (opcional en este proyecto).
 *
 * Uso: `@Body(new ZodValidationPipe(CrearSolicitudDTO)) dto: CrearSolicitudDTO`
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        codigo: 'DATOS_INVALIDOS',
        mensaje: 'Solicitud inválida',
        detalles: result.error.issues.map((i) => ({
          campo: i.path.join('.'),
          error: i.message,
        })),
      });
    }
    return result.data;
  }
}
