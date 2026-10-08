import { HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';

export function invalidCredentials(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'INVALID_CREDENTIALS',
    message: 'Credenciales inválidas',
  });
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
