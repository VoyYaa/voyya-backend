import { type ArgumentsHost, ConflictException, Logger } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

interface FakeResponse {
  locals: Record<string, unknown>;
  status: jest.Mock;
  json: jest.Mock;
}

function buildHost(): { host: ArgumentsHost; res: FakeResponse } {
  const res: FakeResponse = {
    locals: {},
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const req = { method: 'POST', baseUrl: '', path: '/trips/quote', route: { path: '/trips/quote' } };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

describe('AllExceptionsFilter', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('logs the domain code under error_code, never under code', () => {
    const { host } = buildHost();

    new AllExceptionsFilter().catch(
      new ConflictException({ code: 'OUT_OF_COVERAGE', message: 'Fuera de cobertura' }),
      host,
    );

    const logged = warnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(logged.error_code).toBe('OUT_OF_COVERAGE');
    expect(logged).not.toHaveProperty('code');
    expect(logged.status).toBe(409);
  });

  it('exposes the error code to the access log through res.locals', () => {
    const { host, res } = buildHost();

    new AllExceptionsFilter().catch(
      new ConflictException({ code: 'NO_COMPANY_AVAILABLE', message: 'x' }),
      host,
    );

    expect(res.locals.errorCode).toBe('NO_COMPANY_AVAILABLE');
  });

  it('keeps the response body untouched', () => {
    const { host, res } = buildHost();
    const body = { code: 'OUT_OF_COVERAGE', message: 'Fuera de cobertura' };

    new AllExceptionsFilter().catch(new ConflictException(body), host);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(body);
  });

  it('logs INTERNAL_ERROR as error_code for unhandled errors', () => {
    const { host, res } = buildHost();

    new AllExceptionsFilter().catch(new Error('boom'), host);

    const logged = errorSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(logged.error_code).toBe('INTERNAL_ERROR');
    expect(res.locals.errorCode).toBe('INTERNAL_ERROR');
  });
});
