import {
  ForbiddenException,
  GoneException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { JwtService } from '@nestjs/jwt';
import type { EnvService } from '../../config/env.service';
import type { SmsProvider } from '../assignment/ports/sms-provider.port';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import type { Hasher } from './hasher.service';
import { RefreshTokenService } from './refresh-token.service';

function fakeEnv(): EnvService {
  const v: Record<string, unknown> = {
    OTP_LENGTH: 4,
    OTP_TTL_SECONDS: 300,
    OTP_MAX_INTENTOS: 3,
    OTP_RATE_LIMIT_MAX: 3,
    OTP_RATE_LIMIT_VENTANA_SECONDS: 3600,
    OTP_REENVIO_COOLDOWN_SECONDS: 30,
    LOGIN_MAX_INTENTOS: 3,
    LOGIN_BLOQUEO_MINUTOS: 15,
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_DAYS: 30,
    BCRYPT_ROUNDS: 12,
  };
  return { get: (k: string) => v[k] } as unknown as EnvService;
}

type RepoMock = { [K in keyof AuthRepository]: jest.Mock };
type RefreshMock = { [K in keyof RefreshTokenService]: jest.Mock };

function crear() {
  const repo = {
    contarOtpDesde: jest.fn(),
    ultimoOtpCreadoEn: jest.fn(),
    crearOtp: jest.fn(),
    getOtpVigente: jest.fn(),
    incrementarIntentosOtp: jest.fn(),
    consumirOtp: jest.fn().mockResolvedValue(true),
    getUsuarioPorTelefono: jest.fn(),
    getUsuarioPorCorreo: jest.fn(),
    getUsuario: jest.fn(),
    crearPasajeroAutoRegistro: jest.fn(),
    getConductorPorCedula: jest.fn(),
    getConductorEmpresa: jest.fn(),
    registrarFalloConductor: jest.fn(),
    resetIntentosConductor: jest.fn(),
  };
  const refreshTokens = {
    emitir: jest.fn().mockResolvedValue('refresh-1'),
    rotar: jest.fn(),
    revocar: jest.fn().mockResolvedValue(undefined),
    revocarTodosDeUsuario: jest.fn().mockResolvedValue(0),
  };
  const jwt = { sign: jest.fn().mockReturnValue('access-jwt') };
  const emitter = { emit: jest.fn() };
  const sms = { enviar: jest.fn().mockResolvedValue(undefined) };
  const hasher: Hasher = {
    hash: jest.fn(async (x: string) => `hashed:${x}`),
    compare: jest.fn(async (x: string, h: string) => h === `hashed:${x}`),
  };
  const service = new AuthService(
    repo as unknown as AuthRepository,
    refreshTokens as unknown as RefreshTokenService,
    jwt as unknown as JwtService,
    fakeEnv(),
    emitter as unknown as EventEmitter2,
    hasher,
    sms as unknown as SmsProvider,
  );
  return { service, repo, refreshTokens, jwt, emitter, sms, hasher };
}

/** Captura una HttpException para inspeccionar status + código de dominio. */
async function capturar(p: Promise<unknown>): Promise<HttpException> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return e;
    throw e;
  }
  throw new Error('No lanzó excepción');
}
function codigo(e: HttpException): string {
  const r = e.getResponse();
  return typeof r === 'object' && r !== null && 'codigo' in r ? String((r as { codigo: unknown }).codigo) : '';
}

const enFuturo = (): Date => new Date(Date.now() + 60_000);
const usuarioPasajeroNuevo = {
  id_usuario: 10,
  nombre: '',
  apellido: '',
  correo: null,
  contrasena: null,
  rol: 'pasajero',
  estado_cuenta: 'activa',
};

describe('AuthService.solicitarOtp', () => {
  it('happy: crea OTP, lo envía por SMS y responde cooldown/TTL', async () => {
    const { service, repo, sms } = crear();
    (repo as RepoMock).contarOtpDesde.mockResolvedValue(0);
    (repo as RepoMock).ultimoOtpCreadoEn.mockResolvedValue(null);
    (repo as RepoMock).crearOtp.mockResolvedValue(undefined);

    const r = await service.solicitarOtp({ telefono: '3001112233' });

    expect(r).toEqual({ enviado: true, reenviar_en_seg: 30, expira_en_seg: 300 });
    expect((repo as RepoMock).crearOtp).toHaveBeenCalledTimes(1);
    expect((sms as { enviar: jest.Mock }).enviar).toHaveBeenCalledTimes(1);
  });

  it('rate-limit por teléfono → 429 OTP_RATE_LIMIT', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).contarOtpDesde.mockResolvedValue(3); // == OTP_RATE_LIMIT_MAX
    const e = await capturar(service.solicitarOtp({ telefono: '3001112233' }));
    expect(e.getStatus()).toBe(429);
    expect(codigo(e)).toBe('OTP_RATE_LIMIT');
  });

  it('reenvío antes del cooldown → 429 OTP_RATE_LIMIT', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).contarOtpDesde.mockResolvedValue(0);
    (repo as RepoMock).ultimoOtpCreadoEn.mockResolvedValue(new Date(Date.now() - 5_000)); // 5s < 30s
    const e = await capturar(service.solicitarOtp({ telefono: '3001112233' }));
    expect(e.getStatus()).toBe(429);
  });
});

describe('AuthService.verificarOtp', () => {
  it('auto-registro del pasajero + un solo uso (consumido) + tokens', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).getOtpVigente.mockResolvedValue({
      id: 1,
      code_hash: 'hashed:1234',
      intentos: 0,
      expira_en: enFuturo(),
    });
    (repo as RepoMock).getUsuarioPorTelefono.mockResolvedValue(null);
    (repo as RepoMock).crearPasajeroAutoRegistro.mockResolvedValue(usuarioPasajeroNuevo);

    const r = await service.verificarOtp({ telefono: '3001112233', codigo: '1234' });

    expect((repo as RepoMock).consumirOtp).toHaveBeenCalledWith(1); // un solo uso
    expect((repo as RepoMock).crearPasajeroAutoRegistro).toHaveBeenCalledTimes(1); // auto-registro
    expect(r.usuario.rol).toBe('pasajero');
    expect(r.usuario.perfil_completo).toBe(false); // nombre vacío
    expect(r.tokens.access_token).toBe('access-jwt');
    expect(r.tokens.refresh_token).toBe('refresh-1');
  });

  it('sin OTP vigente (o vencido) → 410 OTP_EXPIRADO', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).getOtpVigente.mockResolvedValue(null);
    const e = await capturar(service.verificarOtp({ telefono: '3001112233', codigo: '1234' }));
    expect(e).toBeInstanceOf(GoneException);
    expect(codigo(e)).toBe('OTP_EXPIRADO');
  });

  it('código incorrecto → incrementa intentos y 401 OTP_INVALIDO', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).getOtpVigente.mockResolvedValue({
      id: 7,
      code_hash: 'hashed:9999',
      intentos: 0,
      expira_en: enFuturo(),
    });
    const e = await capturar(service.verificarOtp({ telefono: '3001112233', codigo: '1234' }));
    expect((repo as RepoMock).incrementarIntentosOtp).toHaveBeenCalledWith(7);
    expect(e).toBeInstanceOf(UnauthorizedException);
    expect(codigo(e)).toBe('OTP_INVALIDO');
  });

  it('A-09: consumo atómico perdido (count!==1) → 401 OTP_INVALIDO (no doble sesión)', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).getOtpVigente.mockResolvedValue({
      id: 1,
      code_hash: 'hashed:1234',
      intentos: 0,
      expira_en: enFuturo(),
    });
    (repo as RepoMock).consumirOtp.mockResolvedValue(false); // otra request lo consumió
    const e = await capturar(service.verificarOtp({ telefono: '3001112233', codigo: '1234' }));
    expect(codigo(e)).toBe('OTP_INVALIDO');
  });

  it('tope de verificaciones del código → 429 OTP_MAX_INTENTOS', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).getOtpVigente.mockResolvedValue({
      id: 7,
      code_hash: 'hashed:1234',
      intentos: 3, // == OTP_MAX_INTENTOS
      expira_en: enFuturo(),
    });
    const e = await capturar(service.verificarOtp({ telefono: '3001112233', codigo: '1234' }));
    expect(e.getStatus()).toBe(429);
    expect(codigo(e)).toBe('OTP_MAX_INTENTOS');
  });
});

const conductorBase = {
  id_conductor: 5,
  id_empresa: 2,
  pin: 'hashed:1234',
  estado: 'disponible',
  intentos_fallidos: 0,
  bloqueado_hasta: null,
  nombre: 'Juan',
  apellido: 'Pérez',
  estado_cuenta: 'activa',
};

describe('AuthService.loginConductor', () => {
  it('happy: tokens con rol conductor e id_empresa; resetea intentos', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).getConductorPorCedula.mockResolvedValue({ ...conductorBase });
    const r = await service.loginConductor({ cedula: '71000001', pin: '1234' });
    expect((repo as RepoMock).resetIntentosConductor).toHaveBeenCalledWith(5);
    expect(r.usuario.rol).toBe('conductor');
    expect(r.usuario.id_empresa).toBe(2);
    expect(r.usuario.perfil_completo).toBe(true);
  });

  it('PIN incorrecto (bajo el tope) → 401 CREDENCIALES_INVALIDAS y registra fallo', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).getConductorPorCedula.mockResolvedValue({ ...conductorBase, intentos_fallidos: 0 });
    const e = await capturar(service.loginConductor({ cedula: '71000001', pin: '0000' }));
    expect((repo as RepoMock).registrarFalloConductor).toHaveBeenCalledWith(5, null);
    expect(e).toBeInstanceOf(UnauthorizedException);
    expect(codigo(e)).toBe('CREDENCIALES_INVALIDAS');
  });

  it('PIN incorrecto que alcanza el tope → 429 CUENTA_BLOQUEADA_TEMPORAL', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).getConductorPorCedula.mockResolvedValue({ ...conductorBase, intentos_fallidos: 2 }); // +1 = 3
    const e = await capturar(service.loginConductor({ cedula: '71000001', pin: '0000' }));
    const call = (repo as RepoMock).registrarFalloConductor.mock.calls[0];
    expect(call?.[1]).toBeInstanceOf(Date); // fijó bloqueado_hasta
    expect(e.getStatus()).toBe(429);
    expect(codigo(e)).toBe('CUENTA_BLOQUEADA_TEMPORAL');
  });

  it('ya bloqueado → 429 sin comparar PIN', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).getConductorPorCedula.mockResolvedValue({
      ...conductorBase,
      bloqueado_hasta: enFuturo(),
    });
    const e = await capturar(service.loginConductor({ cedula: '71000001', pin: '1234' }));
    expect(e.getStatus()).toBe(429);
  });

  it('conductor suspendido → 403 CUENTA_SUSPENDIDA', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).getConductorPorCedula.mockResolvedValue({ ...conductorBase, estado: 'suspendido' });
    const e = await capturar(service.loginConductor({ cedula: '71000001', pin: '1234' }));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(codigo(e)).toBe('CUENTA_SUSPENDIDA');
  });

  it('cédula inexistente → 401 (genérico, anti-enumeración)', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).getConductorPorCedula.mockResolvedValue(null);
    const e = await capturar(service.loginConductor({ cedula: '99999999', pin: '1234' }));
    expect(codigo(e)).toBe('CREDENCIALES_INVALIDAS');
  });
});

describe('AuthService.loginAdmin', () => {
  const admin = {
    id_usuario: 1,
    nombre: 'Admin',
    apellido: 'VoyYa',
    correo: 'admin@voyya.co',
    contrasena: 'hashed:Secret12',
    rol: 'admin',
    estado_cuenta: 'activa',
  };

  it('happy: tokens con rol admin', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).getUsuarioPorCorreo.mockResolvedValue({ ...admin });
    const r = await service.loginAdmin({ correo: 'admin@voyya.co', password: 'Secret12' });
    expect(r.usuario.rol).toBe('admin');
    expect(r.usuario.id_empresa).toBeNull();
  });

  it('contraseña incorrecta → 401', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).getUsuarioPorCorreo.mockResolvedValue({ ...admin });
    const e = await capturar(service.loginAdmin({ correo: 'admin@voyya.co', password: 'mala1234' }));
    expect(codigo(e)).toBe('CREDENCIALES_INVALIDAS');
  });

  it('usuario sin rol admin/operador → 401', async () => {
    const { service, repo } = crear();
    (repo as RepoMock).getUsuarioPorCorreo.mockResolvedValue({ ...admin, rol: 'pasajero' });
    const e = await capturar(service.loginAdmin({ correo: 'admin@voyya.co', password: 'Secret12' }));
    expect(codigo(e)).toBe('CREDENCIALES_INVALIDAS');
  });
});

describe('AuthService.refresh / logout / revocación', () => {
  it('refresh: usa el token rotado y emite access nuevo', async () => {
    const { service, repo, refreshTokens } = crear();
    (refreshTokens as RefreshMock).rotar.mockResolvedValue({ id_usuario: 5, refresh_token: 'nuevo-refresh' });
    (repo as RepoMock).getUsuario.mockResolvedValue({ ...conductorBase, id_usuario: 5, rol: 'conductor', estado_cuenta: 'activa' });
    (repo as RepoMock).getConductorEmpresa.mockResolvedValue({ id_empresa: 2, estado: 'disponible' });

    const r = await service.refresh({ refresh_token: 'viejo' });
    expect(r.refresh_token).toBe('nuevo-refresh');
    expect(r.access_token).toBe('access-jwt');
    expect(r.expires_in).toBe(900);
  });

  it('A-01: refresh de pasajero/admin SUSPENDIDO → 401 REFRESH_REVOCADO + revoca familia', async () => {
    const { service, repo, refreshTokens } = crear();
    (refreshTokens as RefreshMock).rotar.mockResolvedValue({ id_usuario: 10, refresh_token: 'nuevo' });
    (repo as RepoMock).getUsuario.mockResolvedValue({
      id_usuario: 10,
      nombre: 'Ana',
      apellido: 'P',
      correo: null,
      contrasena: null,
      rol: 'pasajero',
      estado_cuenta: 'suspendida',
    });
    const e = await capturar(service.refresh({ refresh_token: 'x' }));
    expect(codigo(e)).toBe('REFRESH_REVOCADO');
    expect((refreshTokens as RefreshMock).revocarTodosDeUsuario).toHaveBeenCalledWith(10);
  });

  it('A-01: refresh de conductor SUSPENDIDO → 401 REFRESH_REVOCADO + revoca familia', async () => {
    const { service, repo, refreshTokens } = crear();
    (refreshTokens as RefreshMock).rotar.mockResolvedValue({ id_usuario: 5, refresh_token: 'nuevo' });
    (repo as RepoMock).getUsuario.mockResolvedValue({
      id_usuario: 5,
      nombre: 'J',
      apellido: 'P',
      correo: null,
      contrasena: null,
      rol: 'conductor',
      estado_cuenta: 'activa',
    });
    (repo as RepoMock).getConductorEmpresa.mockResolvedValue({ id_empresa: 2, estado: 'suspendido' });
    const e = await capturar(service.refresh({ refresh_token: 'x' }));
    expect(codigo(e)).toBe('REFRESH_REVOCADO');
    expect((refreshTokens as RefreshMock).revocarTodosDeUsuario).toHaveBeenCalledWith(5);
  });

  it('logout idempotente → { ok: true } y revoca', async () => {
    const { service, refreshTokens } = crear();
    const r = await service.logout({ refresh_token: 'cualquiera' });
    expect(r).toEqual({ ok: true });
    expect((refreshTokens as RefreshMock).revocar).toHaveBeenCalledWith('cualquiera');
  });

  it('suspensión del conductor → revoca todas sus sesiones (HU-AUTH-05)', async () => {
    const { service, refreshTokens } = crear();
    (refreshTokens as RefreshMock).revocarTodosDeUsuario.mockResolvedValue(2);
    await service.onConductorSuspendido({
      id_conductor: 5,
      id_empresa: 2,
      motivo: 'suspendido',
      ocurrido_en: new Date().toISOString(),
    });
    expect((refreshTokens as RefreshMock).revocarTodosDeUsuario).toHaveBeenCalledWith(5);
  });
});
