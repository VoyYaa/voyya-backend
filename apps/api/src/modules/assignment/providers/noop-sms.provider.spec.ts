import { Logger } from '@nestjs/common';
import type { EnvService } from '../../../config/env.service';
import { NoopSmsProvider } from './noop-sms.provider';

function env(vals: Record<string, unknown>): EnvService {
  return { get: (k: string) => vals[k] } as unknown as EnvService;
}

describe('NoopSmsProvider', () => {
  it('logs a masked destination and the message kind, never the body (OTP)', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const p = new NoopSmsProvider(env({ NODE_ENV: 'development' }));

    await p.send('3001112233', 'Tu código VoyYa es 9876', 'otp');

    const logged = logSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('9876');
    expect(logged).not.toContain('3001112233');
    expect(logged).toContain('2233');
    expect(logged).toContain('kind=otp');
    logSpy.mockRestore();
  });

  it('never logs the national id nor the PIN sent to a driver', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const p = new NoopSmsProvider(env({ NODE_ENV: 'development' }));

    await p.send('3001112233', 'VoyYa · cédula 123456789 · PIN 4321', 'driver-credentials');

    const logged = logSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('123456789');
    expect(logged).not.toContain('4321');
    expect(logged).toContain('kind=driver-credentials');
    logSpy.mockRestore();
  });

  it('does not log at all in production', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const p = new NoopSmsProvider(env({ NODE_ENV: 'production' }));

    await p.send('3001112233', 'Tu código VoyYa es 9876', 'otp');

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
