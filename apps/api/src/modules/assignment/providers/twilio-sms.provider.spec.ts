jest.mock('twilio', () => jest.fn());

import { Logger, ServiceUnavailableException } from '@nestjs/common';
import twilio from 'twilio';
import type { EnvService } from '../../../config/env.service';
import { NoopSmsProvider } from './noop-sms.provider';
import { crearSmsProvider } from './sms.factory';
import { TwilioSmsProvider } from './twilio-sms.provider';

const twilioMock = twilio as unknown as jest.Mock;
const CONFIG = { accountSid: 'ACtest123', authToken: 'SECRET-TOKEN', fromNumber: '+15550001111' };

describe('TwilioSmsProvider', () => {
  let createMock: jest.Mock;

  beforeEach(() => {
    createMock = jest.fn().mockResolvedValue({ sid: 'SM1' });
    twilioMock.mockReturnValue({ messages: { create: createMock } });
  });

  it('formatea a E.164 (+57 para 10 dígitos) y usa el `from` configurado', async () => {
    const p = new TwilioSmsProvider(CONFIG);
    await p.enviar('3001112233', 'Tu código VoyYa es 1234');
    expect(createMock).toHaveBeenCalledWith({
      to: '+573001112233',
      from: '+15550001111',
      body: 'Tu código VoyYa es 1234',
    });
  });

  it('respeta un teléfono que ya viene en E.164', async () => {
    const p = new TwilioSmsProvider(CONFIG);
    await p.enviar('+13105551234', 'x');
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ to: '+13105551234' }));
  });

  it('NO loguea el mensaje (OTP), el token ni el teléfono completo', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const p = new TwilioSmsProvider(CONFIG);
    await p.enviar('3001112233', 'Tu código VoyYa es 9876');
    const logged = logSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('9876'); // OTP
    expect(logged).not.toContain('SECRET-TOKEN'); // authToken
    expect(logged).not.toContain('3001112233'); // teléfono completo
    logSpy.mockRestore();
  });

  it('ante error del SDK lanza ServiceUnavailableException sin filtrar el token', async () => {
    const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    createMock.mockRejectedValue(new Error('twilio falló'));
    const p = new TwilioSmsProvider(CONFIG);
    await expect(p.enviar('3001112233', 'msg')).rejects.toBeInstanceOf(ServiceUnavailableException);
    const logged = errSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('SECRET-TOKEN');
    errSpy.mockRestore();
  });
});

describe('crearSmsProvider (selección por entorno)', () => {
  function env(vals: Record<string, unknown>): EnvService {
    return { get: (k: string) => vals[k] } as unknown as EnvService;
  }
  beforeEach(() => {
    twilioMock.mockReturnValue({ messages: { create: jest.fn() } });
  });

  it('con credenciales de Twilio → TwilioSmsProvider (incluso en producción)', () => {
    const p = crearSmsProvider(
      env({
        TWILIO_ACCOUNT_SID: 'ACx',
        TWILIO_AUTH_TOKEN: 'tok',
        TWILIO_FROM_NUMBER: '+15550001111',
        NODE_ENV: 'production',
      }),
    );
    expect(p).toBeInstanceOf(TwilioSmsProvider);
  });

  it('sin credenciales en dev → NoopSmsProvider', () => {
    expect(crearSmsProvider(env({ NODE_ENV: 'development' }))).toBeInstanceOf(NoopSmsProvider);
  });

  it('sin credenciales en producción → fail-fast (throw)', () => {
    expect(() => crearSmsProvider(env({ NODE_ENV: 'production' }))).toThrow();
  });
});
