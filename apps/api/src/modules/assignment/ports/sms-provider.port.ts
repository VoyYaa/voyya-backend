/** Token de inyección del puerto de SMS (DIP). */
export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

/**
 * Puerto de SMS (OTP/PIN, alertas). Abstracción intercambiable (Twilio en piloto,
 * agregador local a escala). Sin lock-in — se conmuta sin tocar la lógica.
 */
export interface SmsProvider {
  enviar(telefono: string, mensaje: string): Promise<void>;
}
