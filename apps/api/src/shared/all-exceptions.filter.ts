import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { resolveRoute } from '../infrastructure/observability/route-pattern';
import { requestContext } from '../infrastructure/observability/request-context.service';
import { captureError } from '../infrastructure/observability/sentry';
import { type SafeErrorFields, toSafeErrorFields } from '../infrastructure/observability/safe-error';

const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      const errorCode = extractCode(body);
      flagErrorCode(res, errorCode);

      if (status >= 500) {
        this.logger.error({
          msg: 'unhandled_http_exception',
          status,
          error_code: errorCode,
          route: resolveRoute(req),
          ...logFieldsOf(exception),
        });
        captureError(exception);
      } else {
        this.logger.warn({
          msg: 'http_exception',
          status,
          error_code: errorCode,
          route: resolveRoute(req),
        });
      }

      res.status(status).json(typeof body === 'string' ? { message: body } : body);
      return;
    }

    flagErrorCode(res, INTERNAL_ERROR_CODE);
    this.logger.error({
      msg: 'unhandled_error',
      error_code: INTERNAL_ERROR_CODE,
      route: resolveRoute(req),
      ...logFieldsOf(exception),
    });
    captureError(exception);

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: INTERNAL_ERROR_CODE,
      message: 'Error interno del servidor',
      request_id: requestContext.get()?.requestId,
    });
  }
}

function logFieldsOf(exception: unknown): Omit<SafeErrorFields, 'name'> & { error_name: string } {
  const { name, ...rest } = toSafeErrorFields(exception);
  return { error_name: name, ...rest };
}

function flagErrorCode(res: Response, errorCode: string | undefined): void {
  if (errorCode && res.locals) res.locals.errorCode = errorCode;
}

function extractCode(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const code = (body as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
