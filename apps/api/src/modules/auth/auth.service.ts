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
  type ConductorSuspendidoEvent,
  EVENTO_CONDUCTOR_SUSPENDIDO,
  EVENTOS_AUTH,
  type LoginAdminDTO,
  type LoginConductorDTO,
  type LogoutDTO,
  type RefreshDTO,
  type RespuestaLogout,
  type RespuestaSesion,
  type SesionIniciadaEvent,
  type SesionTokens,
  type SolicitarOtpDTO,
  type SolicitarOtpRespuesta,
  Rol,
  type VerificarOtpDTO,
} from '@voyya/shared';
import { EnvService } from '../../config/env.service';
import { SMS_PROVIDER, type SmsProvider } from '../assignment/ports/sms-provider.port';
import { AuthRepository } from './auth.repository';
import { HASHER, type Hasher } from './hasher.service';
import { RefreshTokenService } from './refresh-token.service';

interface PerfilSesion {
  id_usuario: number;
  nombre: string;
  apellido: string;
  rol: string;
}

/**
 * AuthService — OTP pasajero, login conductor/admin, refresh (rotación + reúso),
 * logout idempotente y revocación al suspender conductor (ADR-005 · HU-AUTH-01…06).
 * Responsabilidad única: identidad. No conoce dominios de negocio; publica eventos.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** Hash válido para igualar el timing cuando el sujeto no existe (anti-enumeración). */
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

  // ===========================================================================
  // HU-AUTH-01 · OTP del pasajero
  // ===========================================================================
  // TODO(pre-prod): A-05 OTP de 6 dígitos + tope de verificaciones fallidas AGREGADO
  //   por teléfono; A-06 anti-abuso SMS (tope global diario + alertas de gasto +
  //   App Attestation/Play Integrity) al activar Twilio. Ver reporte-autenticacion.md.
  async solicitarOtp(dto: SolicitarOtpDTO): Promise<SolicitarOtpRespuesta> {
    const telefono = normalizarTelefono(dto.telefono);

    // Rate-limit por teléfono (el de IP lo cubre @nestjs/throttler en el borde).
    const ventanaSeg = this.env.get('OTP_RATE_LIMIT_VENTANA_SECONDS');
    const desde = new Date(Date.now() - ventanaSeg * 1000);
    const emitidos = await this.repo.contarOtpDesde(telefono, desde);
    if (emitidos >= this.env.get('OTP_RATE_LIMIT_MAX')) {
      throw this.rateLimitOtp(ventanaSeg);
    }
    const cooldown = this.env.get('OTP_REENVIO_COOLDOWN_SECONDS');
    const ultimo = await this.repo.ultimoOtpCreadoEn(telefono);
    if (ultimo) {
      const transcurrido = (Date.now() - ultimo.getTime()) / 1000;
      if (transcurrido < cooldown) {
        throw this.rateLimitOtp(Math.ceil(cooldown - transcurrido));
      }
    }

    const ttl = this.env.get('OTP_TTL_SECONDS');
    const codigo = generarCodigo(this.env.get('OTP_LENGTH'));
    const hash = await this.hasher.hash(codigo);
    await this.repo.crearOtp(telefono, hash, new Date(Date.now() + ttl * 1000));

    // Puerto SmsProvider (NoopSmsProvider registra en consola en dev; Twilio en piloto).
    await this.sms.enviar(dto.telefono, `Tu código VoyYa es ${codigo}`);

    return { enviado: true, reenviar_en_seg: cooldown, expira_en_seg: ttl };
  }

  async verificarOtp(dto: VerificarOtpDTO, userAgent?: string): Promise<RespuestaSesion> {
    const telefono = normalizarTelefono(dto.telefono);
    const otp = await this.repo.getOtpVigente(telefono);
    if (!otp || otp.expira_en.getTime() < Date.now()) {
      throw new GoneException({ codigo: 'OTP_EXPIRADO', mensaje: 'El código venció, solicita otro' });
    }
    if (otp.intentos >= this.env.get('OTP_MAX_INTENTOS')) {
      throw new HttpException(
        { codigo: 'OTP_MAX_INTENTOS', mensaje: 'Demasiados intentos, solicita otro código' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const ok = await this.hasher.compare(dto.codigo, otp.code_hash);
    if (!ok) {
      await this.repo.incrementarIntentosOtp(otp.id);
      throw new UnauthorizedException({ codigo: 'OTP_INVALIDO', mensaje: 'Código incorrecto' });
    }

    // A-09: consumo ATÓMICO (un solo uso). Si otra request lo consumió a la vez,
    // count!==1 → tratamos el código como inválido (no se emite doble sesión).
    const consumido = await this.repo.consumirOtp(otp.id);
    if (!consumido) {
      throw new UnauthorizedException({ codigo: 'OTP_INVALIDO', mensaje: 'Código ya utilizado' });
    }

    let usuario = await this.repo.getUsuarioPorTelefono(telefono);
    if (!usuario) {
      usuario = await this.repo.crearPasajeroAutoRegistro(telefono); // D-A01
    }
    if (usuario.estado_cuenta === 'suspendida') {
      throw new ForbiddenException({ codigo: 'CUENTA_SUSPENDIDA', mensaje: 'Cuenta suspendida' });
    }

    return this.emitirSesion(usuario, null, userAgent);
  }

  // ===========================================================================
  // HU-AUTH-02 · Login del conductor (cédula + PIN, con lockout)
  // ===========================================================================
  async loginConductor(dto: LoginConductorDTO, userAgent?: string): Promise<RespuestaSesion> {
    const c = await this.repo.getConductorPorCedula(dto.cedula);
    if (!c) {
      await this.hasher.compare(dto.pin, await this.dummyHash); // timing constante
      throw this.credencialesInvalidas();
    }
    if (c.bloqueado_hasta && c.bloqueado_hasta.getTime() > Date.now()) {
      throw this.cuentaBloqueada(Math.ceil((c.bloqueado_hasta.getTime() - Date.now()) / 1000));
    }

    const ok = await this.hasher.compare(dto.pin, c.pin);
    if (!ok) {
      const intentos = c.intentos_fallidos + 1;
      const bloqueado =
        intentos >= this.env.get('LOGIN_MAX_INTENTOS')
          ? new Date(Date.now() + this.env.get('LOGIN_BLOQUEO_MINUTOS') * 60_000)
          : null;
      await this.repo.registrarFalloConductor(c.id_conductor, bloqueado);
      if (bloqueado) throw this.cuentaBloqueada(this.env.get('LOGIN_BLOQUEO_MINUTOS') * 60);
      throw this.credencialesInvalidas();
    }

    if (
      c.estado === 'suspendido' ||
      c.estado === 'bloqueado_documentos' ||
      c.estado_cuenta === 'suspendida'
    ) {
      throw new ForbiddenException({ codigo: 'CUENTA_SUSPENDIDA', mensaje: 'Cuenta no habilitada' });
    }

    await this.repo.resetIntentosConductor(c.id_conductor);
    return this.emitirSesion(
      { id_usuario: c.id_conductor, nombre: c.nombre, apellido: c.apellido, rol: 'conductor' },
      c.id_empresa,
      userAgent,
    );
  }

  // ===========================================================================
  // HU-AUTH-03 · Login admin/operador (correo + contraseña)
  // ===========================================================================
  async loginAdmin(dto: LoginAdminDTO, userAgent?: string): Promise<RespuestaSesion> {
    const u = await this.repo.getUsuarioPorCorreo(dto.correo.toLowerCase());
    const habilitado = u && u.contrasena && (u.rol === 'admin' || u.rol === 'operador');
    if (!habilitado) {
      await this.hasher.compare(dto.password, await this.dummyHash);
      throw this.credencialesInvalidas();
    }
    const ok = await this.hasher.compare(dto.password, u.contrasena as string);
    if (!ok) throw this.credencialesInvalidas();
    if (u.estado_cuenta === 'suspendida') {
      throw new ForbiddenException({ codigo: 'CUENTA_SUSPENDIDA', mensaje: 'Cuenta suspendida' });
    }
    return this.emitirSesion(u, null, userAgent);
  }

  // ===========================================================================
  // HU-AUTH-04 · Refresh (rota ambos) y logout (idempotente)
  // ===========================================================================
  async refresh(dto: RefreshDTO, userAgent?: string): Promise<SesionTokens> {
    const { id_usuario, refresh_token } = await this.refreshTokens.rotar(dto.refresh_token, userAgent);
    const u = await this.repo.getUsuario(id_usuario);
    if (!u) {
      throw new UnauthorizedException({ codigo: 'REFRESH_INVALIDO', mensaje: 'Refresh inválido' });
    }

    // A-01: la cuenta debe seguir HABILITADA al renovar (no solo al iniciar sesión).
    // Si no, se corta la familia de refresh (el access vivo caduca en ≤15 min).
    if (u.estado_cuenta === 'suspendida') {
      await this.refreshTokens.revocarTodosDeUsuario(id_usuario);
      throw this.refreshRevocado();
    }

    let idEmpresa: number | undefined;
    if (u.rol === 'conductor') {
      const c = await this.repo.getConductorEmpresa(id_usuario);
      if (!c || c.estado === 'suspendido' || c.estado === 'bloqueado_documentos' || c.estado === 'inactivo') {
        await this.refreshTokens.revocarTodosDeUsuario(id_usuario);
        throw this.refreshRevocado();
      }
      idEmpresa = c.id_empresa;
    }

    return {
      access_token: this.firmarAccess(u.id_usuario, u.rol, idEmpresa),
      refresh_token,
      token_type: 'Bearer',
      expires_in: this.env.get('JWT_ACCESS_TTL_SECONDS'),
    };
  }

  private refreshRevocado(): UnauthorizedException {
    return new UnauthorizedException({ codigo: 'REFRESH_REVOCADO', mensaje: 'Sesión revocada' });
  }

  async logout(dto: LogoutDTO): Promise<RespuestaLogout> {
    await this.refreshTokens.revocar(dto.refresh_token); // idempotente
    return { ok: true };
  }

  // ===========================================================================
  // HU-AUTH-05 · Revocación al suspender/bloquear un conductor
  // ===========================================================================
  @OnEvent(EVENTO_CONDUCTOR_SUSPENDIDO)
  async onConductorSuspendido(ev: ConductorSuspendidoEvent): Promise<void> {
    const n = await this.refreshTokens.revocarTodosDeUsuario(ev.id_conductor);
    this.logger.log(`Sesiones revocadas=${n} conductor=${ev.id_conductor} motivo=${ev.motivo}`);
  }

  /** D-A06 (temporal): dispara el corte de sesión sin el módulo fleet/admin aún. */
  emitirSuspensionConductor(ev: ConductorSuspendidoEvent): void {
    this.emitter.emit(EVENTO_CONDUCTOR_SUSPENDIDO, ev);
  }

  // ===========================================================================
  // Privados
  // ===========================================================================
  private async emitirSesion(
    usuario: PerfilSesion,
    idEmpresa: number | null,
    userAgent?: string,
  ): Promise<RespuestaSesion> {
    const rol = Rol.parse(usuario.rol);
    const access = this.firmarAccess(usuario.id_usuario, rol, idEmpresa ?? undefined);
    const refresh = await this.refreshTokens.emitir(usuario.id_usuario, userAgent);

    const evento: SesionIniciadaEvent = {
      id_usuario: usuario.id_usuario,
      rol,
      ocurrido_en: new Date().toISOString(),
    };
    this.emitter.emit(EVENTOS_AUTH.SESION_INICIADA, evento);

    return {
      tokens: {
        access_token: access,
        refresh_token: refresh,
        token_type: 'Bearer',
        expires_in: this.env.get('JWT_ACCESS_TTL_SECONDS'),
      },
      usuario: {
        id_usuario: usuario.id_usuario,
        nombre: usuario.nombre,
        apellido: usuario.apellido,
        rol,
        id_empresa: idEmpresa,
        perfil_completo: rol !== 'pasajero' || usuario.nombre.trim().length > 0,
      },
    };
  }

  private firmarAccess(sub: number, rol: string, idEmpresa?: number): string {
    const payload = {
      sub,
      rol,
      type: 'access' as const,
      ...(idEmpresa !== undefined ? { id_empresa: idEmpresa } : {}),
    };
    return this.jwt.sign(payload);
  }

  private credencialesInvalidas(): UnauthorizedException {
    return new UnauthorizedException({
      codigo: 'CREDENCIALES_INVALIDAS',
      mensaje: 'Credenciales inválidas',
    });
  }

  private cuentaBloqueada(reintentarEnSeg: number): HttpException {
    return new HttpException(
      {
        codigo: 'CUENTA_BLOQUEADA_TEMPORAL',
        mensaje: 'Cuenta bloqueada temporalmente por intentos fallidos',
        reintentar_en_seg: reintentarEnSeg,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private rateLimitOtp(reintentarEnSeg: number): HttpException {
    return new HttpException(
      {
        codigo: 'OTP_RATE_LIMIT',
        mensaje: 'Demasiadas solicitudes de código, intenta más tarde',
        reintentar_en_seg: reintentarEnSeg,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Normaliza a 10 dígitos (quita `+57`/`57` y separadores). */
function normalizarTelefono(telefono: string): string {
  const d = telefono.replace(/\D/g, '');
  return d.length === 12 && d.startsWith('57') ? d.slice(2) : d;
}

/** Código OTP de `longitud` dígitos con relleno de ceros (aleatorio seguro). */
function generarCodigo(longitud: number): string {
  return randomInt(0, 10 ** longitud)
    .toString()
    .padStart(longitud, '0');
}
