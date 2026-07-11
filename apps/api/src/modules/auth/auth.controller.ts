import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import {
  ConductorSuspendidoEvent,
  LoginAdminDTO,
  LoginConductorDTO,
  LogoutDTO,
  RefreshDTO,
  type RespuestaLogout,
  type RespuestaSesion,
  type SesionTokens,
  SolicitarOtpDTO,
  type SolicitarOtpRespuesta,
  VerificarOtpDTO,
} from '@voyya/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { Roles } from './decorators/roles.decorator';

// A-04: límites por IP/minuto DEDICADOS y más estrictos que el global (100/min).
const TTL = 60_000;
const LIMITE = { otpSolicitar: 3, otpVerificar: 10, login: 5, refresh: 30 } as const;

/** Rutas PÚBLICAS de autenticación (no exigen access token — ADR-005). */
@Controller('auth')
@Public()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('otp/solicitar')
  @HttpCode(200)
  @Throttle({ default: { limit: LIMITE.otpSolicitar, ttl: TTL } })
  solicitarOtp(
    @Body(new ZodValidationPipe(SolicitarOtpDTO)) dto: SolicitarOtpDTO,
  ): Promise<SolicitarOtpRespuesta> {
    return this.auth.solicitarOtp(dto);
  }

  @Post('otp/verificar')
  @HttpCode(200)
  @Throttle({ default: { limit: LIMITE.otpVerificar, ttl: TTL } })
  verificarOtp(
    @Body(new ZodValidationPipe(VerificarOtpDTO)) dto: VerificarOtpDTO,
    @Headers('user-agent') userAgent?: string,
  ): Promise<RespuestaSesion> {
    return this.auth.verificarOtp(dto, userAgent);
  }

  @Post('conductor/login')
  @HttpCode(200)
  @Throttle({ default: { limit: LIMITE.login, ttl: TTL } })
  loginConductor(
    @Body(new ZodValidationPipe(LoginConductorDTO)) dto: LoginConductorDTO,
    @Headers('user-agent') userAgent?: string,
  ): Promise<RespuestaSesion> {
    return this.auth.loginConductor(dto, userAgent);
  }

  @Post('admin/login')
  @HttpCode(200)
  @Throttle({ default: { limit: LIMITE.login, ttl: TTL } })
  loginAdmin(
    @Body(new ZodValidationPipe(LoginAdminDTO)) dto: LoginAdminDTO,
    @Headers('user-agent') userAgent?: string,
  ): Promise<RespuestaSesion> {
    return this.auth.loginAdmin(dto, userAgent);
  }

  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: LIMITE.refresh, ttl: TTL } })
  refresh(
    @Body(new ZodValidationPipe(RefreshDTO)) dto: RefreshDTO,
    @Headers('user-agent') userAgent?: string,
  ): Promise<SesionTokens> {
    return this.auth.refresh(dto, userAgent);
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Body(new ZodValidationPipe(LogoutDTO)) dto: LogoutDTO): Promise<RespuestaLogout> {
    return this.auth.logout(dto);
  }
}

// Body del endpoint temporal (el servidor añade ocurrido_en).
const SuspenderConductorDTO = ConductorSuspendidoEvent.omit({ ocurrido_en: true });
type SuspenderConductorDTO = z.infer<typeof SuspenderConductorDTO>;

/**
 * Endpoint TEMPORAL (D-A06 · A-11) para probar la revocación por suspensión ANTES de
 * que exista el módulo fleet/admin. PROTEGIDO: exige JWT + rol admin. Emite el evento
 * `fleet.conductor_suspendido` que AuthService escucha para revocar las sesiones.
 * TODO(Ciclo fleet/admin): la emisión real vivirá al suspender/bloquear un conductor.
 */
@Controller('auth/admin')
export class AuthAdminController {
  constructor(private readonly auth: AuthService) {}

  @Post('suspender-conductor')
  @HttpCode(200)
  @Roles('admin')
  suspenderConductor(
    @Body(new ZodValidationPipe(SuspenderConductorDTO)) dto: SuspenderConductorDTO,
  ): { ok: true } {
    this.auth.emitirSuspensionConductor({ ...dto, ocurrido_en: new Date().toISOString() });
    return { ok: true };
  }
}
