export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

export type SmsKind = 'otp' | 'driver-credentials';

export interface SmsProvider {
  send(phone: string, message: string, kind?: SmsKind): Promise<void>;
}
