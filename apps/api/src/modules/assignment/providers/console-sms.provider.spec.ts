import { Logger } from '@nestjs/common';
import { redactPii } from '@voyyaa/shared';
import { ConsoleSmsProvider } from './console-sms.provider';

describe('ConsoleSmsProvider', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints the masked destination and the full body behind the development-only prefix', async () => {
    await new ConsoleSmsProvider().send('+573001112233', 'Tu código VoyYa es 9876', 'otp');

    const logged = logSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('[sms:console · SOLO DESARROLLO]');
    expect(logged).toContain('Tu código VoyYa es 9876');
    expect(logged).toContain('2233');
    expect(logged).not.toContain('3001112233');
    expect(logged).toContain('kind=otp');
  });

  it('reports an unknown kind when none is given', async () => {
    await new ConsoleSmsProvider().send('3001112233', 'hola');

    expect(logSpy.mock.calls.flat().join(' ')).toContain('kind=unknown');
  });

  it('survives the textual PII redaction applied by the logger, so the OTP stays readable', async () => {
    await new ConsoleSmsProvider().send('+573001112233', 'Tu código VoyYa es 9876', 'otp');

    const line = logSpy.mock.calls[0][0] as string;
    expect(redactPii(line)).toBe(line);
    expect(redactPii(line)).toContain('9876');
  });
});
