import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createRequestContextMiddleware } from './request-context.middleware';
import { RequestContextService } from './request-context.service';

function buildPair(statusCode: number, locals: Record<string, unknown>) {
  const req = {
    method: 'POST',
    path: '/trips/quote',
    baseUrl: '',
    headers: {},
    route: { path: '/trips/quote' },
  } as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    statusCode,
    locals,
    setHeader: jest.fn(),
  }) as unknown as Response;
  return { req, res };
}

describe('request context middleware access log', () => {
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('includes error_code when the exception filter flagged one', () => {
    const middleware = createRequestContextMiddleware(new RequestContextService());
    const { req, res } = buildPair(409, { errorCode: 'OUT_OF_COVERAGE' });

    middleware(req, res, jest.fn());
    res.emit('finish');

    const line = warnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(line.error_code).toBe('OUT_OF_COVERAGE');
    expect(line).not.toHaveProperty('code');
  });

  it('omits error_code on successful requests', () => {
    const middleware = createRequestContextMiddleware(new RequestContextService());
    const { req, res } = buildPair(201, {});

    middleware(req, res, jest.fn());
    res.emit('finish');

    const line = logSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(line.error_code).toBeUndefined();
  });
});
