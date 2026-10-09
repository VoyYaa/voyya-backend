import { Writable } from 'node:stream';
import { Prisma } from '@prisma/client';
import { buildLogger } from './logger.factory';
import { PinoLoggerService } from './pino-logger.service';

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = buildLogger({ level: 'debug', service: 'api', env: 'test' }, destination);
  return { logger, output: () => lines.join('') };
}

describe('buildLogger redaction', () => {
  it('keeps the domain error_code visible', () => {
    const { logger, output } = capture();

    logger.warn({ msg: 'http_exception', status: 409, error_code: 'OUT_OF_COVERAGE' });

    expect(output()).toContain('"error_code":"OUT_OF_COVERAGE"');
  });

  it('redacts the OTP code in a logged verify request body', () => {
    const { logger, output } = capture();

    logger.info({ req: { method: 'POST', body: { phone: '3001112233', code: '4821' } } });

    expect(output()).not.toContain('4821');
    expect(output()).not.toContain('3001112233');
  });

  it.each([
    ['body', { body: { code: '4821' } }],
    ['nested body', { ctx: { body: { code: '4821' } } }],
    ['otp object', { otp: { code: '4821' } }],
    ['nested otp object', { ctx: { otp: { code: '4821' } } }],
    ['otp_code', { otp_code: '4821' }],
    ['nested otp_code', { ctx: { otp_code: '4821' } }],
    ['otp', { otp: '4821' }],
  ])('redacts the OTP code carried in %s', (_label, payload) => {
    const { logger, output } = capture();

    logger.info({ msg: 'probe', ...payload });

    expect(output()).not.toContain('4821');
  });

  it.each(['current_pin', 'new_pin'])('redacts %s at the top level and nested (CM-10)', (key) => {
    const { logger, output } = capture();

    logger.info({ msg: 'probe', [key]: '482193', ctx: { [key]: '735104' } });

    expect(output()).not.toContain('482193');
    expect(output()).not.toContain('735104');
  });

  it.each(['lat', 'lng', 'current_lat', 'current_lng'])(
    'redacts the coordinate %s at the top level and nested (CM-10)',
    (key) => {
      const { logger, output } = capture();

      logger.info({ msg: 'probe', [key]: 6.96391, ctx: { [key]: -75.41862 } });

      expect(output()).not.toContain('6.96391');
      expect(output()).not.toContain('75.41862');
    },
  );

  it('redacts a PIN-labelled value inside a text message', () => {
    const { logger, output } = capture();

    logger.info('driver credentials PIN 482193');

    expect(output()).not.toContain('482193');
  });

  it('routes the PinoLoggerService error object without hiding error_code', () => {
    const { logger, output } = capture();
    const service = new PinoLoggerService(logger);

    service.warn({ msg: 'http', status: 409, error_code: 'NO_COMPANY_AVAILABLE' }, 'AccessLog');

    expect(output()).toContain('"error_code":"NO_COMPANY_AVAILABLE"');
    expect(output()).not.toContain('[redacted]');
  });

  describe('PostgreSQL error detail', () => {
    const ROW = 'Failing row contains (41, Carrera 21 #14-33, 6.96123417, -75.41759902, 482913)';

    it('redacts the failing row inside object arguments, nested objects and arrays', () => {
      const { logger, output } = capture();

      logger.error({ msg: 'failed', detail: `DETAIL: ${ROW}`, nested: { list: [`x ${ROW}`] } });

      expect(output()).not.toContain('Carrera 21');
      expect(output()).not.toContain('6.96123417');
      expect(output()).not.toContain('482913');
    });

    it('serializes an Error under err without its message, stack or meta when it comes from Prisma', () => {
      const { logger, output } = capture();
      const error = new Prisma.PrismaClientKnownRequestError(`DETAIL: ${ROW}`, {
        code: 'P2010',
        clientVersion: '5.22.0',
        meta: { code: '23514', message: `violates check constraint "c_x"
DETAIL: ${ROW}` },
      });

      logger.error({ err: error, msg: 'failed' });

      const entry = JSON.parse(output()) as { err: Record<string, unknown> };
      expect(entry.err).toEqual({
        name: 'PrismaClientKnownRequestError',
        prisma_code: 'P2010',
        sqlstate: '23514',
        constraint: 'c_x',
      });
      expect(output()).not.toContain('Carrera 21');
    });

    it('redacts the message and stack of a generic Error passed as the first argument', () => {
      const { logger, output } = capture();

      logger.error(new Error('call 300 111 2233'), 'failed');

      expect(output()).not.toContain('300 111 2233');
      expect(output()).toContain('[phone]');
    });

    it('redacts sensitive keys added by ADR-033', () => {
      const { logger, output } = capture();

      logger.info({ ctx: { start_code: '482913', startCode: '482913', driver_tracking: 'x', position: 'y' } });

      expect(output()).not.toContain('482913');
      expect(output()).not.toContain('"x"');
      expect(output()).not.toContain('"y"');
    });

    it('keeps dates and numbers of a logged object', () => {
      const { logger, output } = capture();

      logger.info({ at: new Date('2026-10-09T00:00:00.000Z'), assignment: 412 });

      expect(output()).toContain('"at":"2026-10-09T00:00:00.000Z"');
      expect(output()).toContain('"assignment":412');
    });
  });
});
