// =============================================================================
// TOMA ÚNICA ATÓMICA — test de concurrencia (HU-08 · ADR-002). CRÍTICO.
// -----------------------------------------------------------------------------
// No requiere Docker. Modela FIELMENTE las DOS barreras de PostgreSQL con undo
// por transacción (rollback a nivel de fila, no de toda la DB):
//   Barrera 1: UPDATE conductor ... WHERE estado='disponible'  (CAS atómico)
//   Barrera 2: UPDATE solicitud  ... WHERE estado='pendiente'  (CAS atómico) +
//              ROLLBACK que libera al conductor del perdedor.
// Las mutaciones del "repo" son SÍNCRONAS (como el row-lock del motor SQL); el
// resto del servicio es async, por lo que Promise.all SÍ interleava las corrutinas.
//
// La atomicidad REAL la garantiza Postgres (ver test/assignment.concurrency.e2e-spec.ts,
// que corre el UPDATE...RETURNING real cuando PG_TEST_URL está definido).
// =============================================================================

import { NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { AssignmentService } from './assignment.service';
import type { AssignmentParamsService } from './assignment-params.service';
import type { AssignmentRepository } from './assignment.repository';
import type { CandidateRepository } from './candidate.repository';
import type { PushProvider } from './ports/push-provider.port';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';

interface CondRow {
  estado: string;
  id_empresa: number;
}
interface AsigRow {
  id_asignacion: number;
  id_solicitud: number;
  id_conductor: number;
  id_empresa: number;
  estado: string;
  expira_en: Date | null;
}
interface SolRow {
  estado: string;
}

class FakeTx {
  idEmpresa = 0;
  private undos: Array<() => void> = [];
  registrarUndo(fn: () => void): void {
    this.undos.push(fn);
  }
  rollback(): void {
    for (let i = this.undos.length - 1; i >= 0; i--) {
      const u = this.undos[i];
      if (u) u();
    }
  }
}

/** Almacén en memoria; cada mutación es CAS síncrono (como el row-lock de Postgres). */
class FakeDb {
  conductores = new Map<number, CondRow>();
  asignaciones = new Map<number, AsigRow>();
  solicitudes = new Map<number, SolRow>();

  tomarConductor(tx: FakeTx, id: number, idEmpresa: number): boolean {
    const c = this.conductores.get(id);
    if (c && c.estado === 'disponible' && c.id_empresa === idEmpresa) {
      c.estado = 'en_servicio';
      tx.registrarUndo(() => {
        c.estado = 'disponible';
      });
      return true;
    }
    return false;
  }
  aceptarAsignacion(tx: FakeTx, id: number): boolean {
    const a = this.asignaciones.get(id);
    if (a && a.estado === 'notificada') {
      a.estado = 'aceptada';
      tx.registrarUndo(() => {
        a.estado = 'notificada';
      });
      return true;
    }
    return false;
  }
  asignarSolicitud(tx: FakeTx, id: number): boolean {
    const s = this.solicitudes.get(id);
    if (s && s.estado === 'pendiente_de_asignacion') {
      s.estado = 'asignada';
      tx.registrarUndo(() => {
        s.estado = 'pendiente_de_asignacion';
      });
      return true;
    }
    return false;
  }
}

function construirServicio(db: FakeDb): AssignmentService {
  const prisma = {
    // runInTenant con rollback POR TRANSACCIÓN (row-level), no de toda la DB.
    async runInTenant<T>(idEmpresa: number, fn: (tx: FakeTx) => Promise<T>): Promise<T> {
      const tx = new FakeTx();
      tx.idEmpresa = idEmpresa;
      try {
        return await fn(tx);
      } catch (e) {
        tx.rollback();
        throw e;
      }
    },
  } as unknown as PrismaService;

  const repo = {
    // Lectura tenant-scoped (modela RLS: no ve asignaciones de otra empresa).
    async getAsignacion(tx: FakeTx, id: number): Promise<AsigRow | null> {
      const a = db.asignaciones.get(id);
      if (!a || a.id_empresa !== tx.idEmpresa) return null;
      return { ...a };
    },
    async tomarConductor(tx: FakeTx, id: number, idEmpresa: number): Promise<boolean> {
      return db.tomarConductor(tx, id, idEmpresa);
    },
    async marcarAsignacionAceptada(tx: FakeTx, id: number): Promise<boolean> {
      return db.aceptarAsignacion(tx, id);
    },
    async marcarSolicitudAsignada(tx: FakeTx, id: number): Promise<boolean> {
      return db.asignarSolicitud(tx, id);
    },
    async getDatosPasajero(): Promise<{
      nombre: string;
      telefono: string;
      direccion_recogida: string;
    }> {
      return { nombre: 'Ana', telefono: '3000000000', direccion_recogida: 'Cra 1' };
    },
  } as unknown as AssignmentRepository;

  const emitter = { emit: () => true } as unknown as EventEmitter2;
  const push = { async enviarAsignacion() {} } as unknown as PushProvider;
  const candidateRepo = {} as unknown as CandidateRepository;
  const params = {} as unknown as AssignmentParamsService;

  return new AssignmentService(prisma, candidateRepo, repo, params, emitter, push);
}

const EMPRESA = 1;
const SOLICITUD = 500;
const enFuturo = (): Date => new Date(Date.now() + 60_000);

describe('AssignmentService · TOMA ÚNICA ATÓMICA (concurrencia)', () => {
  it('N conductores compiten por 1 solicitud → EXACTAMENTE 1 gana; el resto "ya_tomada"', async () => {
    const N = 25;
    const db = new FakeDb();
    db.solicitudes.set(SOLICITUD, { estado: 'pendiente_de_asignacion' });
    for (let i = 1; i <= N; i++) {
      db.conductores.set(i, { estado: 'disponible', id_empresa: EMPRESA });
      db.asignaciones.set(i, {
        id_asignacion: i,
        id_solicitud: SOLICITUD,
        id_conductor: i,
        id_empresa: EMPRESA,
        estado: 'notificada',
        expira_en: enFuturo(),
      });
    }
    const service = construirServicio(db);

    // Todas las aceptaciones "al mismo tiempo".
    const resultados = await Promise.all(
      Array.from({ length: N }, (_v, k) =>
        service.aceptar(k + 1, k + 1, EMPRESA, {}),
      ),
    );

    const ganadores = resultados.filter((r) => r.resultado === 'aceptada');
    const perdedores = resultados.filter((r) => r.resultado === 'ya_tomada');

    expect(ganadores).toHaveLength(1); // ← criterio de éxito del piloto
    expect(perdedores).toHaveLength(N - 1);

    // La solicitud quedó asignada UNA vez.
    expect(db.solicitudes.get(SOLICITUD)?.estado).toBe('asignada');
    // Exactamente un conductor en servicio; el resto liberado por el ROLLBACK.
    const enServicio = [...db.conductores.values()].filter((c) => c.estado === 'en_servicio');
    const disponibles = [...db.conductores.values()].filter((c) => c.estado === 'disponible');
    expect(enServicio).toHaveLength(1);
    expect(disponibles).toHaveLength(N - 1);
  });

  it('doble-submit del MISMO conductor → 1 aceptada, el resto "ya_tomada"', async () => {
    const db = new FakeDb();
    db.solicitudes.set(SOLICITUD, { estado: 'pendiente_de_asignacion' });
    db.conductores.set(7, { estado: 'disponible', id_empresa: EMPRESA });
    db.asignaciones.set(70, {
      id_asignacion: 70,
      id_solicitud: SOLICITUD,
      id_conductor: 7,
      id_empresa: EMPRESA,
      estado: 'notificada',
      expira_en: enFuturo(),
    });
    const service = construirServicio(db);

    const resultados = await Promise.all(
      Array.from({ length: 10 }, () => service.aceptar(70, 7, EMPRESA, {})),
    );

    expect(resultados.filter((r) => r.resultado === 'aceptada')).toHaveLength(1);
    expect(db.conductores.get(7)?.estado).toBe('en_servicio');
  });

  it('aislamiento multi-tenant: aceptar con id_empresa ajeno NO ve la asignación (404)', async () => {
    const db = new FakeDb();
    db.solicitudes.set(SOLICITUD, { estado: 'pendiente_de_asignacion' });
    db.conductores.set(9, { estado: 'disponible', id_empresa: 2 });
    db.asignaciones.set(90, {
      id_asignacion: 90,
      id_solicitud: SOLICITUD,
      id_conductor: 9,
      id_empresa: 2,
      estado: 'notificada',
      expira_en: enFuturo(),
    });
    const service = construirServicio(db);

    // Empresa 1 intenta aceptar una asignación de la empresa 2.
    await expect(service.aceptar(90, 9, 1, {})).rejects.toBeInstanceOf(NotFoundException);
    // El conductor de la empresa 2 sigue disponible (no fue tocado).
    expect(db.conductores.get(9)?.estado).toBe('disponible');
  });
});

describe('AssignmentService.listarCercanas (GET /assignments/cercanas · polling)', () => {
  function construir(getOfertas: jest.Mock, getUbicacion: jest.Mock): AssignmentService {
    const prisma = {
      runInTenant: async <T>(_e: number, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
    } as unknown as PrismaService;
    const repo = {
      getOfertasPendientes: getOfertas,
      getUbicacionConductor: getUbicacion,
    } as unknown as AssignmentRepository;
    const emitter = { emit: () => true } as unknown as EventEmitter2;
    const push = { async enviarAsignacion() {} } as unknown as PushProvider;
    const candidateRepo = {} as unknown as CandidateRepository;
    const params = {} as unknown as AssignmentParamsService;
    return new AssignmentService(prisma, candidateRepo, repo, params, emitter, push);
  }

  const oferta = {
    id_asignacion: 11,
    id_solicitud: 100,
    expira_en: new Date(Date.now() + 15_000),
    direccion_recogida: 'Cra 20 # 30-40',
    direccion_destino: 'Barrio La Loma, calle 5',
    lat_recogida: 6.963,
    lng_recogida: -75.418,
    tarifa: 8000,
  };

  it('conductor con oferta pendiente → la ve con la forma de NotificacionAsignacion', async () => {
    const getOfertas = jest.fn().mockResolvedValue([oferta]);
    const service = construir(getOfertas, jest.fn().mockResolvedValue({ lat: 6.965, lng: -75.42 }));

    const r = await service.listarCercanas(5, 1);

    expect(r).toHaveLength(1);
    const n = r[0];
    expect(n?.id_asignacion).toBe(11);
    expect(n?.id_solicitud).toBe(100);
    expect(n?.origen).toEqual({ direccion: 'Cra 20 # 30-40', lat: 6.963, lng: -75.418 });
    expect(n?.destino_barrio).toBe('Barrio La Loma'); // barrioDe: texto antes de la coma
    expect(n?.tarifa_total).toBe(8000);
    expect(n?.distancia_al_origen_m).toBeGreaterThan(0);
    expect(typeof n?.expira_en).toBe('string');
    expect(n?.segundos_para_responder).toBeGreaterThan(0);
    // La consulta es TENANT-scoped: recibe el id_empresa del JWT.
    expect(getOfertas).toHaveBeenCalledWith(expect.anything(), 5, 1);
  });

  it('conductor sin ofertas → lista vacía', async () => {
    const service = construir(jest.fn().mockResolvedValue([]), jest.fn().mockResolvedValue(null));
    expect(await service.listarCercanas(5, 1)).toEqual([]);
  });

  it('aislamiento multi-tenant: no ve ofertas de otra empresa', async () => {
    const getOfertas = jest.fn(async (_tx: unknown, _idc: number, idEmpresa: number) =>
      idEmpresa === 1 ? [oferta] : [],
    );
    const service = construir(getOfertas, jest.fn().mockResolvedValue(null));

    expect(await service.listarCercanas(5, 2)).toEqual([]); // empresa ajena → nada
    expect(await service.listarCercanas(5, 1)).toHaveLength(1); // su empresa → su oferta
    expect(getOfertas).toHaveBeenCalledWith(expect.anything(), 5, 2);
  });
});
