jest.mock('twilio', () => jest.fn());

import { Logger, ServiceUnavailableException } from '@nestjs/common';
import twilio from 'twilio';
import { TwilioSmsProvider } from './twilio-sms.provider';

const twilioMock = twilio as unknown as jest.Mock;
const CONFIG = { accountSid: 'ACtest123', authToken: 'SECRET-TOKEN', fromNumber: '+15550001111' };

describe('TwilioSmsProvider', () => {
  let createMock: jest.Mock;

  beforeEach(() => {
    createMock = jest.fn().mockResolvedValue({ sid: 'SM1' });
    twilioMock.mockReturnValue({ messages: { create: createMock } });
  });

  it('formats to E.164 (+57 for 10 digits) and uses the configured `from`', async () => {
    const p = new TwilioSmsProvider(CONFIG);
    await p.send('3001112233', 'Tu código VoyYa es 1234');
    expect(createMock).toHaveBeenCalledWith({
      to: '+573001112233',
      from: '+15550001111',
      body: 'Tu código VoyYa es 1234',
    });
  });

  it('respects a phone already in E.164', async () => {
    const p = new TwilioSmsProvider(CONFIG);
    await p.send('+13105551234', 'x');
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ to: '+13105551234' }));
  });

  it('does NOT log the message (OTP), the token nor the full phone', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const p = new TwilioSmsProvider(CONFIG);
    await p.send('3001112233', 'Tu código VoyYa es 9876');
    const logged = logSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('9876');
    expect(logged).not.toContain('SECRET-TOKEN');
    expect(logged).not.toContain('3001112233');
    logSpy.mockRestore();
  });

  it('on SDK error throws ServiceUnavailableException without leaking the token', async () => {
    const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    createMock.mockRejectedValue(new Error('twilio failed'));
    const p = new TwilioSmsProvider(CONFIG);
    await expect(p.send('3001112233', 'msg')).rejects.toBeInstanceOf(ServiceUnavailableException);
    const logged = errSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('SECRET-TOKEN');
    errSpy.mockRestore();
  });
});
