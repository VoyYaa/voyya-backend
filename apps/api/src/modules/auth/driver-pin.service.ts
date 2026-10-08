import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { type ChangeDriverPinDTO, isPinFromPersonalData, type SessionResponse } from '@voyyaa/shared';
import { EnvService } from '../../config/env.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { accountBlocked, invalidCredentials, temporaryPinExpired } from './auth-errors';
import { AuthService, type SessionProfile } from './auth.service';
import { DriverPinRepository, type LockedDriver } from './driver-pin.repository';
import { HASHER, type Hasher } from './hasher.service';
import { lockoutAfterFailure } from './login-lockout';
import { RefreshTokenService } from './refresh-token.service';

const IDEMPOTENT_RETRY_WINDOW_MS = 60_000;

type Evaluation = { error: HttpException } | { profile: SessionProfile };

@Injectable()
export class DriverPinService {
  private readonly logger = new Logger(DriverPinService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: DriverPinRepository,
    @Inject(HASHER) private readonly hasher: Hasher,
    private readonly env: EnvService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly auth: AuthService,
  ) {}

  async changePin(
    driverId: number,
    companyId: number,
    dto: ChangeDriverPinDTO,
    userAgent?: string,
  ): Promise<SessionResponse> {
    const evaluation = await this.prisma.runInTenant(companyId, (tx) =>
      this.evaluate(tx, driverId, companyId, dto),
    );
    if ('error' in evaluation) throw evaluation.error;

    await this.refreshTokens.revokeAllForUser(driverId);
    const session = await this.auth.issueSession(evaluation.profile, companyId, userAgent);
    this.logger.log(`Driver PIN changed driver=${driverId}`);
    return session;
  }

  private async evaluate(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
    dto: ChangeDriverPinDTO,
  ): Promise<Evaluation> {
    const driver = await this.repo.lockDriver(tx, driverId, companyId);
    if (!driver) return { error: invalidCredentials() };

    if (driver.blockedUntil && driver.blockedUntil.getTime() > Date.now()) {
      return { error: accountBlocked(secondsUntil(driver.blockedUntil)) };
    }

    if (!(await this.hasher.compare(dto.current_pin, driver.pin))) {
      if (await this.isRepeatOfCompletedChange(driver, dto.new_pin)) {
        return { profile: toProfile(driver) };
      }
      return { error: await this.countFailure(tx, driver, companyId) };
    }

    if (isSuspended(driver)) {
      return {
        error: new ForbiddenException({ code: 'ACCOUNT_SUSPENDED', message: 'Cuenta no habilitada' }),
      };
    }
    if (driver.pinMustChange && isExpired(driver.temporaryPinExpiresAt)) {
      return { error: temporaryPinExpired() };
    }
    if (isPinFromPersonalData(dto.new_pin, [driver.nationalId, driver.phone])) {
      return { error: pinTooWeak() };
    }

    await this.repo.applyNewPin(tx, driverId, companyId, await this.hasher.hash(dto.new_pin));
    return { profile: toProfile(driver) };
  }

  private async isRepeatOfCompletedChange(driver: LockedDriver, newPin: string): Promise<boolean> {
    if (driver.pinMustChange || driver.pinChangedAt === null) return false;
    if (Date.now() - driver.pinChangedAt.getTime() >= IDEMPOTENT_RETRY_WINDOW_MS) return false;
    return this.hasher.compare(newPin, driver.pin);
  }

  private async countFailure(
    tx: Prisma.TransactionClient,
    driver: LockedDriver,
    companyId: number,
  ): Promise<HttpException> {
    const blockedUntil = lockoutAfterFailure(this.env, driver.failedAttempts);
    await this.repo.registerFailure(tx, driver.driverId, companyId, blockedUntil);
    if (blockedUntil) return accountBlocked(this.env.get('LOGIN_BLOCK_MINUTES') * 60);
    return invalidCredentials();
  }
}

function toProfile(driver: LockedDriver): SessionProfile {
  return {
    userId: driver.driverId,
    firstName: driver.firstName,
    lastName: driver.lastName,
    role: 'driver',
  };
}

function isSuspended(driver: LockedDriver): boolean {
  return (
    driver.status === 'suspended' ||
    driver.status === 'documents_blocked' ||
    driver.accountStatus === 'suspended'
  );
}

function isExpired(expiresAt: Date | null): boolean {
  return expiresAt !== null && expiresAt.getTime() <= Date.now();
}

function secondsUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / 1000);
}

function pinTooWeak(): HttpException {
  return new HttpException(
    {
      code: 'PIN_TOO_WEAK',
      message: 'Elige un PIN que no salga de tu cédula ni de tu teléfono.',
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}
