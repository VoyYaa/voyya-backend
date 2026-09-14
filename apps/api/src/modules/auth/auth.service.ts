import { randomInt } from 'node:crypto';
import {
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import {
  type AdminLoginDTO,
  AUTH_EVENTS,
  type DriverLoginDTO,
  DRIVER_SUSPENDED_EVENT,
  type DriverSuspendedEvent,
  type LogoutDTO,
  type LogoutResponse,
  type RefreshDTO,
  type RequestOtpDTO,
  type RequestOtpResponse,
  Role,
  type SessionResponse,
  type SessionStartedEvent,
  type SessionTokens,
  type VerifyOtpDTO,
} from '@voyyaa/shared';
import { EnvService } from '../../config/env.service';
import { SMS_PROVIDER, type SmsProvider } from '../assignment/ports/sms-provider.port';
import { AuthRepository } from './auth.repository';
import { HASHER, type Hasher } from './hasher.service';
import { RefreshTokenService } from './refresh-token.service';

interface SessionProfile {
  userId: number;
  firstName: string;
  lastName: string;
  role: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly dummyHash: Promise<string>;

  constructor(
    private readonly repo: AuthRepository,
    private readonly refreshTokens: RefreshTokenService,
    private readonly jwt: JwtService,
    private readonly env: EnvService,
    private readonly emitter: EventEmitter2,
    @Inject(HASHER) private readonly hasher: Hasher,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
  ) {
    this.dummyHash = this.hasher.hash('timing-dummy-secret');
  }

  async requestOtp(dto: RequestOtpDTO): Promise<RequestOtpResponse> {
    const phone = normalizePhone(dto.phone);

    const windowSec = this.env.get('OTP_RATE_LIMIT_WINDOW_SECONDS');
    const since = new Date(Date.now() - windowSec * 1000);
    const issued = await this.repo.countOtpSince(phone, since);
    if (issued >= this.env.get('OTP_RATE_LIMIT_MAX')) {
      throw this.otpRateLimit(windowSec);
    }
    const cooldown = this.env.get('OTP_RESEND_COOLDOWN_SECONDS');
    const last = await this.repo.lastOtpCreatedAt(phone);
    if (last) {
      const elapsed = (Date.now() - last.getTime()) / 1000;
      if (elapsed < cooldown) {
        throw this.otpRateLimit(Math.ceil(cooldown - elapsed));
      }
    }

    const ttl = this.env.get('OTP_TTL_SECONDS');
    const code = generateCode(this.env.get('OTP_LENGTH'));
    const hash = await this.hasher.hash(code);
    await this.repo.createOtp(phone, hash, new Date(Date.now() + ttl * 1000));

    await this.sms.send(dto.phone, `Tu código VoyYa es ${code}`);

    return { sent: true, resend_in_sec: cooldown, expires_in_sec: ttl };
  }

  async verifyOtp(dto: VerifyOtpDTO, userAgent?: string): Promise<SessionResponse> {
    const phone = normalizePhone(dto.phone);
    const otp = await this.repo.getActiveOtp(phone);
    if (!otp || otp.expiresAt.getTime() < Date.now()) {
      throw new GoneException({ code: 'OTP_EXPIRED', message: 'El código venció, solicita otro' });
    }
    if (otp.attempts >= this.env.get('OTP_MAX_ATTEMPTS')) {
      throw new HttpException(
        { code: 'OTP_MAX_ATTEMPTS', message: 'Demasiados intentos, solicita otro código' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const ok = await this.hasher.compare(dto.code, otp.codeHash);
    if (!ok) {
      await this.repo.incrementOtpAttempts(otp.id);
      throw new UnauthorizedException({ code: 'OTP_INVALID', message: 'Código incorrecto' });
    }

    const consumed = await this.repo.consumeOtp(otp.id);
    if (!consumed) {
      throw new UnauthorizedException({ code: 'OTP_INVALID', message: 'Código ya utilizado' });
    }

    let user = await this.repo.getUserByPhone(phone);
    if (!user) {
      user = await this.repo.createPassengerAutoRegister(phone);
    }
    if (user.accountStatus === 'suspended') {
      throw new ForbiddenException({ code: 'ACCOUNT_SUSPENDED', message: 'Cuenta suspendida' });
    }

    return this.issueSession(user, null, userAgent);
  }

  async driverLogin(dto: DriverLoginDTO, userAgent?: string): Promise<SessionResponse> {
    const d = await this.repo.getDriverByNationalId(dto.national_id);
    if (!d) {
      await this.hasher.compare(dto.pin, await this.dummyHash);
      throw this.invalidCredentials();
    }
    if (d.blockedUntil && d.blockedUntil.getTime() > Date.now()) {
      throw this.accountBlocked(Math.ceil((d.blockedUntil.getTime() - Date.now()) / 1000));
    }

    const ok = await this.hasher.compare(dto.pin, d.pin);
    if (!ok) {
      const attempts = d.failedAttempts + 1;
      const blocked =
        attempts >= this.env.get('LOGIN_MAX_ATTEMPTS')
          ? new Date(Date.now() + this.env.get('LOGIN_BLOCK_MINUTES') * 60_000)
          : null;
      await this.repo.registerDriverFailure(d.driverId, d.companyId, blocked);
      if (blocked) throw this.accountBlocked(this.env.get('LOGIN_BLOCK_MINUTES') * 60);
      throw this.invalidCredentials();
    }

    if (
      d.status === 'suspended' ||
      d.status === 'documents_blocked' ||
      d.accountStatus === 'suspended'
    ) {
      throw new ForbiddenException({ code: 'ACCOUNT_SUSPENDED', message: 'Cuenta no habilitada' });
    }

    await this.repo.resetDriverAttempts(d.driverId, d.companyId);
    return this.issueSession(
      { userId: d.driverId, firstName: d.firstName, lastName: d.lastName, role: 'driver' },
      d.companyId,
      userAgent,
    );
  }

  async adminLogin(dto: AdminLoginDTO, userAgent?: string): Promise<SessionResponse> {
    const u = await this.repo.getUserByEmail(dto.email.toLowerCase());
    const enabled = u && u.passwordHash && (u.role === 'admin' || u.role === 'operator');
    if (!enabled) {
      await this.hasher.compare(dto.password, await this.dummyHash);
      throw this.invalidCredentials();
    }
    const ok = await this.hasher.compare(dto.password, u.passwordHash as string);
    if (!ok) throw this.invalidCredentials();
    if (u.accountStatus === 'suspended') {
      throw new ForbiddenException({ code: 'ACCOUNT_SUSPENDED', message: 'Cuenta suspendida' });
    }
    return this.issueSession(u, null, userAgent);
  }

  async refresh(dto: RefreshDTO, userAgent?: string): Promise<SessionTokens> {
    const { userId, refreshToken } = await this.refreshTokens.rotate(dto.refresh_token, userAgent);
    const u = await this.repo.getUser(userId);
    if (!u) {
      throw new UnauthorizedException({ code: 'REFRESH_INVALID', message: 'Refresh inválido' });
    }

    if (u.accountStatus === 'suspended') {
      await this.refreshTokens.revokeAllForUser(userId);
      throw this.refreshRevoked();
    }

    let companyId: number | undefined;
    if (u.role === 'driver') {
      const d = await this.repo.getDriverCompany(userId);
      if (!d || d.status === 'suspended' || d.status === 'documents_blocked' || d.status === 'inactive') {
        await this.refreshTokens.revokeAllForUser(userId);
        throw this.refreshRevoked();
      }
      companyId = d.companyId;
    }

    return {
      access_token: this.signAccess(u.userId, u.role, companyId),
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: this.env.get('JWT_ACCESS_TTL_SECONDS'),
    };
  }

  private refreshRevoked(): UnauthorizedException {
    return new UnauthorizedException({ code: 'REFRESH_REVOKED', message: 'Sesión revocada' });
  }

  async logout(dto: LogoutDTO): Promise<LogoutResponse> {
    await this.refreshTokens.revoke(dto.refresh_token);
    return { ok: true };
  }

  @OnEvent(DRIVER_SUSPENDED_EVENT)
  async onDriverSuspended(ev: DriverSuspendedEvent): Promise<void> {
    const n = await this.refreshTokens.revokeAllForUser(ev.driver_id);
    this.logger.log(`Sessions revoked=${n} driver=${ev.driver_id} reason=${ev.reason}`);
  }

  emitDriverSuspension(ev: DriverSuspendedEvent): void {
    this.emitter.emit(DRIVER_SUSPENDED_EVENT, ev);
  }

  private async issueSession(
    user: SessionProfile,
    companyId: number | null,
    userAgent?: string,
  ): Promise<SessionResponse> {
    const role = Role.parse(user.role);
    const access = this.signAccess(user.userId, role, companyId ?? undefined);
    const refresh = await this.refreshTokens.issue(user.userId, userAgent);

    const event: SessionStartedEvent = {
      user_id: user.userId,
      role,
      occurred_at: new Date().toISOString(),
    };
    this.emitter.emit(AUTH_EVENTS.SESSION_STARTED, event);

    return {
      tokens: {
        access_token: access,
        refresh_token: refresh,
        token_type: 'Bearer',
        expires_in: this.env.get('JWT_ACCESS_TTL_SECONDS'),
      },
      user: {
        user_id: user.userId,
        first_name: user.firstName,
        last_name: user.lastName,
        role,
        company_id: companyId,
        profile_complete: role !== 'passenger' || user.firstName.trim().length > 0,
      },
    };
  }

  private signAccess(sub: number, role: string, companyId?: number): string {
    const payload = {
      sub,
      role,
      type: 'access' as const,
      ...(companyId !== undefined ? { company_id: companyId } : {}),
    };
    return this.jwt.sign(payload);
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'INVALID_CREDENTIALS',
      message: 'Credenciales inválidas',
    });
  }

  private accountBlocked(retryInSec: number): HttpException {
    return new HttpException(
      {
        code: 'ACCOUNT_TEMPORARILY_BLOCKED',
        message: 'Cuenta bloqueada temporalmente por intentos fallidos',
        retry_in_sec: retryInSec,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private otpRateLimit(retryInSec: number): HttpException {
    return new HttpException(
      {
        code: 'OTP_RATE_LIMIT',
        message: 'Demasiadas solicitudes de código, intenta más tarde',
        retry_in_sec: retryInSec,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

function normalizePhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length === 12 && d.startsWith('57') ? d.slice(2) : d;
}

function generateCode(length: number): string {
  return randomInt(0, 10 ** length)
    .toString()
    .padStart(length, '0');
}
