import { Writable } from 'node:stream';
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
});
