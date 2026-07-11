export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

export interface SmsProvider {
  send(phone: string, message: string): Promise<void>;
}
