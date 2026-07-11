import {
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { ConductorAsignadoResumen, CrearSolicitudDTO } from '@voyya/shared';
import type { EnvService } from '../../config/env.service';
import type { AssignmentService } from '../assignment/assignment.service';
import type { FestivosProvider } from './festivos/festivos.provider';
import { QuoteTokenService } from './quote-token.service';
import { TripsRepository } from './trips.repository';
import { TripsService } from './trips.service';

const SECRETO = 'test-secret-0123456789';
const SIN_FESTIVOS: FestivosProvider = { esFestivo: () => false };

function fakeEnv(ttl = 120): EnvService {
  const valores: Record<string, unknown> = {
    QUOTE_TOKEN_TTL_SECONDS: ttl,
    QUOTE_TOKEN_SECRET: SECRETO,
    VENTANA_CANCELACION_MIN: 2,
  };
  return { get: (k: string) => valores[k] } as unknown as EnvService;
}

interface SolicitudFake {
  id_solicitud: number;
  id_cliente: number;
  estado: string;
  asignada_en: Date | null;
  actualizado_en: Date;
  // Campos usados por obtenerEstado / reconstruirTarifa (P1.1):
  id_municipio?: number;
  tipo_servicio?: string;
  tarifa?: number;
  comision?: number;
  fecha_hora_solicitud?: Date;
}
interface EstadoFake {
  cubierto?: boolean;
  activa?: boolean;
  solicitud?: SolicitudFake | null;
  resumen?: ConductorAsignadoResumen | null;
}

function fakeRepo(estado: EstadoFake): TripsRepository {
  return {
    async puntoDentroDeCobertura(): Promise<boolean> {
      return estado.cubierto ?? true;
    },
    async getTarifaVigente(): Promise<unknown> {
      return {
        tarifa_base: 8000,
        recargo_nocturno_pct: 20,
        recargo_festivo_pct: 15,
        comision_pct: 8,
      };
    },
    async existeSolicitudActiva(): Promise<boolean> {
      return estado.activa ?? false;
    },
    async crearSolicitud(): Promise<unknown> {
      return {
        id_solicitud: 123,
        id_cliente: 1,
        id_municipio: 1,
        tipo_servicio: 'taxi',
        lat_recogida: 6.9639,
        lng_recogida: -75.4186,
        fecha_hora_solicitud: new Date('2026-07-10T12:00:00.000Z'),
      };
    },
    async getSolicitud(): Promise<unknown> {
      return estado.solicitud ?? null;
    },
    async actualizarEstado(): Promise<void> {
      return undefined;
    },
  } as unknown as TripsRepository;
}

function fakeAssignment(resumen: ConductorAsignadoResumen | null): AssignmentService {
  return {
    async getResumenConductorAsignado(): Promise<ConductorAsignadoResumen | null> {
      return resumen;
    },
  } as unknown as AssignmentService;
}

const ORIGEN = { lat: 6.9639, lng: -75.4186, direccion: 'Parque principal' };
const DESTINO = { lat: 6.97, lng: -75.42, direccion: 'Hospital' };

function crearServicio(
  estado: EstadoFake = {},
  ttl = 120,
): { service: TripsService; emitter: { emit: jest.Mock } } {
  const env = fakeEnv(ttl);
  const quote = new QuoteTokenService(env);
  const emitter = { emit: jest.fn(() => true) };
  const service = new TripsService(
    fakeRepo(estado),
    quote,
    env,
    emitter as unknown as EventEmitter2,
    SIN_FESTIVOS,
    fakeAssignment(estado.resumen ?? null),
  );
  return { service, emitter };
}

describe('TripsService.cotizar', () => {
  it('dentro de cobertura → tarifa fija cerrada + token + efectivo', async () => {
    const { service } = crearServicio({ cubierto: true, activa: false });
    const r = await service.cotizar({
      origen: ORIGEN,
      destino: DESTINO,
      id_municipio: 1,
      tipo_servicio: 'taxi',
    });
    expect(r.dentro_cobertura).toBe(true);
    expect(r.metodo_pago).toBe('efectivo');
    expect(r.tarifa.tarifa_base).toBe(8000);
    expect(r.tarifa.total).toBeGreaterThanOrEqual(8000);
    expect(r.cotizacion_token.length).toBeGreaterThan(0);
    expect(r.eta).toBeNull();
  });

  it('fuera de cobertura → 409 FUERA_DE_COBERTURA', async () => {
    const { service } = crearServicio({ cubierto: false, activa: false });
    await expect(
      service.cotizar({ origen: ORIGEN, destino: DESTINO, id_municipio: 1, tipo_servicio: 'taxi' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('TripsService.crear', () => {
  const dtoCon = (token: string): CrearSolicitudDTO => ({
    origen: ORIGEN,
    destino: DESTINO,
    id_municipio: 1,
    tipo_servicio: 'taxi',
    metodo_pago: 'efectivo',
    cotizacion_token: token,
  });
  async function tokenValido(service: TripsService): Promise<string> {
    const r = await service.cotizar({
      origen: ORIGEN,
      destino: DESTINO,
      id_municipio: 1,
      tipo_servicio: 'taxi',
    });
    return r.cotizacion_token;
  }

  it('con token válido → crea, cierra la tarifa y emite solicitud.creada', async () => {
    const { service, emitter } = crearServicio({ cubierto: true, activa: false });
    const r = await service.crear(dtoCon(await tokenValido(service)), 1);
    expect(r.id_solicitud).toBe(123);
    expect(r.estado).toBe('pendiente_de_asignacion');
    expect(r.tarifa.total).toBeGreaterThanOrEqual(8000);
    expect(emitter.emit).toHaveBeenCalledWith('solicitud.creada', expect.anything());
  });

  it('idempotencia: ya existe solicitud activa → 409 SOLICITUD_ACTIVA_EXISTENTE', async () => {
    const { service } = crearServicio({ cubierto: true, activa: true });
    await expect(service.crear(dtoCon(await tokenValido(service)), 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('P1.2: revalida cobertura al crear → 409 aunque el token sea válido', async () => {
    // Token emitido cuando SÍ había cobertura...
    const cubierto = crearServicio({ cubierto: true });
    const token = await tokenValido(cubierto.service);
    // ...pero al crear la cobertura ya no aplica (mismo secreto → token válido).
    const sinCobertura = crearServicio({ cubierto: false, activa: false });
    await expect(sinCobertura.service.crear(dtoCon(token), 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('token expirado → 410 COTIZACION_EXPIRADA', async () => {
    const expirador = new QuoteTokenService(fakeEnv(-10));
    const tokenVencido = expirador.firmar({
      id_municipio: 1,
      tipo_servicio: 'taxi',
      origen: { lat: ORIGEN.lat, lng: ORIGEN.lng },
      destino: { lat: DESTINO.lat, lng: DESTINO.lng },
      distancia_km: 1,
      tarifa: {
        tarifa_base: 8000,
        recargo_nocturno: 0,
        recargo_festivo: 0,
        total: 8000,
        comision: 640,
        moneda: 'COP',
      },
    });
    const { service } = crearServicio({ cubierto: true, activa: false });
    await expect(service.crear(dtoCon(tokenVencido), 1)).rejects.toBeInstanceOf(GoneException);
  });
});

describe('TripsService.obtenerEstado (P1.1 · GET /trips/:id)', () => {
  const base = (over: Partial<SolicitudFake>): SolicitudFake => ({
    id_solicitud: 9,
    id_cliente: 1,
    estado: 'pendiente_de_asignacion',
    asignada_en: null,
    actualizado_en: new Date(),
    id_municipio: 1,
    tipo_servicio: 'taxi',
    tarifa: 8000,
    comision: 640,
    fecha_hora_solicitud: new Date(),
    ...over,
  });
  const RESUMEN: ConductorAsignadoResumen = {
    nombre: 'Carlos Ruiz',
    placa: 'ABC123',
    modelo: 'Logan',
    telefono_contacto: '3001234567',
    eta: null,
  };

  it('pendiente → conductor null, ui "buscando", tarifa cerrada', async () => {
    const { service } = crearServicio({ solicitud: base({}) });
    const r = await service.obtenerEstado(9, 1);
    expect(r.estado).toBe('pendiente_de_asignacion');
    expect(r.ui).toBe('buscando');
    expect(r.conductor).toBeNull();
    expect(r.tarifa.total).toBe(8000);
    expect(r.tarifa.moneda).toBe('COP');
  });

  it('asignada → conductor presente, ui "conductor_asignado"', async () => {
    const { service } = crearServicio({
      solicitud: base({ estado: 'asignada', asignada_en: new Date() }),
      resumen: RESUMEN,
    });
    const r = await service.obtenerEstado(9, 1);
    expect(r.ui).toBe('conductor_asignado');
    expect(r.conductor).toEqual(RESUMEN);
  });

  it('no es el dueño → 403 NO_ES_DUENO', async () => {
    const { service } = crearServicio({ solicitud: base({ id_cliente: 2 }) });
    await expect(service.obtenerEstado(9, 1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('no existe → 404 SOLICITUD_NO_EXISTE', async () => {
    const { service } = crearServicio({ solicitud: null });
    await expect(service.obtenerEstado(9, 1)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TripsService.cancelar (R-03: ventana desde asignada_en)', () => {
  const haceMin = (m: number): Date => new Date(Date.now() - m * 60_000);
  const solic = (over: Partial<SolicitudFake>): SolicitudFake => ({
    id_solicitud: 5,
    id_cliente: 1,
    estado: 'asignada',
    asignada_en: haceMin(1),
    actualizado_en: haceMin(1),
    ...over,
  });

  it('pendiente_de_asignacion → gratuita, sin penalidad, emite solicitud.cancelada', async () => {
    const { service, emitter } = crearServicio({
      solicitud: solic({ estado: 'pendiente_de_asignacion', asignada_en: null, actualizado_en: haceMin(10) }),
    });
    const r = await service.cancelar(5, 1, {});
    expect(r.gratuita).toBe(true);
    expect(r.penalidad_registrada).toBe(false);
    expect(r.estado).toBe('cancelada_cliente');
    expect(emitter.emit).toHaveBeenCalledWith('solicitud.cancelada', expect.anything());
  });

  it('asignada hace ≤2 min → gratuita', async () => {
    const { service } = crearServicio({ solicitud: solic({ asignada_en: haceMin(1) }) });
    const r = await service.cancelar(5, 1, {});
    expect(r.gratuita).toBe(true);
    expect(r.penalidad_registrada).toBe(false);
  });

  it('asignada hace >2 min → penalidad (mide desde asignada_en, NO actualizado_en)', async () => {
    // actualizado_en es RECIENTE (el proxy antiguo daría "gratis"); asignada_en 5 min atrás.
    const { service } = crearServicio({
      solicitud: solic({ asignada_en: haceMin(5), actualizado_en: haceMin(0) }),
    });
    const r = await service.cancelar(5, 1, {});
    expect(r.gratuita).toBe(false);
    expect(r.penalidad_registrada).toBe(true);
  });

  it('no es el dueño → 403 NO_ES_DUENO', async () => {
    const { service } = crearServicio({ solicitud: solic({ id_cliente: 2 }) });
    await expect(service.cancelar(5, 1, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('no existe → 404 SOLICITUD_NO_EXISTE', async () => {
    const { service } = crearServicio({ solicitud: null });
    await expect(service.cancelar(5, 1, {})).rejects.toBeInstanceOf(NotFoundException);
  });
});
