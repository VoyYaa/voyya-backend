import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Filtro global de excepciones (C-4). Nunca filtra stack ni detalle interno al
 * cliente: los `HttpException` reenvían su cuerpo tipado ({ codigo, mensaje, … });
 * cualquier otro error responde 500 genérico y se registra SOLO el mensaje en
 * servidor (sin stack, sin PII).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(typeof body === 'string' ? { mensaje: body } : body);
      return;
    }

    this.logger.error(
      `Error no controlado: ${exception instanceof Error ? exception.message : String(exception)}`,
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      codigo: 'ERROR_INTERNO',
      mensaje: 'Error interno del servidor',
    });
  }
}
