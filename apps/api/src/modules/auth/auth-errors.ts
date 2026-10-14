import { GoneException, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';

export function invalidCredentials(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'INVALID_CREDENTIALS',
    message: 'Credenciales inválidas',
  });
}

export function invalidOtp(): UnauthorizedException {
  return new UnauthorizedException({ code: 'OTP_INVALID', message: 'Código incorrecto' });
}

export function temporaryPinExpired(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'TEMPORARY_PIN_EXPIRED',
    message: 'Tu PIN temporal venció. Pide a tu empresa que lo reenvíe.',
  });
}

export function accountBlocked(retryInSec: number): HttpException {
  return new HttpException(
    {
      code: 'ACCOUNT_TEMPORARILY_BLOCKED',
      message: 'Cuenta bloqueada temporalmente por intentos fallidos',
      retry_in_sec: retryInSec,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

export function otpExpired(): GoneException {
  return new GoneException({ code: 'OTP_EXPIRED', message: 'El código venció, solicita otro' });
}

export function otpMaxAttempts(): HttpException {
  return new HttpException(
    { code: 'OTP_MAX_ATTEMPTS', message: 'Demasiados intentos, solicita otro código' },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

export function otpRateLimit(retryInSec: number): HttpException {
  return new HttpException(
    {
      code: 'OTP_RATE_LIMIT',
      message: 'Demasiadas solicitudes de código, intenta más tarde',
      retry_in_sec: retryInSec,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

export class OtpGlobalDailyCapReachedError extends Error {
  constructor(count: number, limit: number) {
    super(`OTP global daily cap reached: count=${count} limit=${limit}`);
    this.name = 'OtpGlobalDailyCapReachedError';
  }
}
