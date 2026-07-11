import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface UsuarioAuth {
  id_usuario: number;
  nombre: string;
  apellido: string;
  correo: string | null;
  contrasena: string | null;
  rol: string;
  estado_cuenta: string;
}

export interface ConductorAuth {
  id_conductor: number;
  id_empresa: number;
  pin: string;
  estado: string;
  intentos_fallidos: number;
  bloqueado_hasta: Date | null;
  nombre: string;
  apellido: string;
  estado_cuenta: string;
}

/**
 * Acceso a datos del dominio AUTH (auth.usuario / users.pasajero / fleet.conductor /
 * auth.codigo_otp). Todas GLOBALES al usuario (sin tenant/RLS). El refresh_token lo
 * gestiona RefreshTokenService (cohesión).
 */
@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- Usuario / pasajero ----------------------------------------------------

  async getUsuarioPorTelefono(telefono: string): Promise<UsuarioAuth | null> {
    return this.prisma.usuario.findUnique({
      where: { telefono },
      select: selUsuario,
    });
  }

  async getUsuarioPorCorreo(correo: string): Promise<UsuarioAuth | null> {
    return this.prisma.usuario.findUnique({ where: { correo }, select: selUsuario });
  }

  async getUsuario(idUsuario: number): Promise<UsuarioAuth | null> {
    return this.prisma.usuario.findUnique({ where: { id_usuario: idUsuario }, select: selUsuario });
  }

  /** Auto-registro del pasajero (D-A01): Usuario mínimo + Pasajero, en una transacción. */
  async crearPasajeroAutoRegistro(telefono: string): Promise<UsuarioAuth> {
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.usuario.create({
        data: { nombre: '', apellido: '', telefono, rol: 'pasajero', estado_cuenta: 'activa' },
        select: selUsuario,
      });
      await tx.pasajero.create({ data: { id_cliente: u.id_usuario } });
      return u;
    });
  }

  // --- Conductor (login + lockout) -------------------------------------------

  async getConductorPorCedula(cedula: string): Promise<ConductorAuth | null> {
    const c = await this.prisma.conductor.findUnique({
      where: { cedula },
      select: {
        id_conductor: true,
        id_empresa: true,
        pin: true,
        estado: true,
        intentos_fallidos: true,
        bloqueado_hasta: true,
        usuario: { select: { nombre: true, apellido: true, estado_cuenta: true } },
      },
    });
    if (!c) return null;
    return {
      id_conductor: c.id_conductor,
      id_empresa: c.id_empresa,
      pin: c.pin,
      estado: c.estado,
      intentos_fallidos: c.intentos_fallidos,
      bloqueado_hasta: c.bloqueado_hasta,
      nombre: c.usuario.nombre,
      apellido: c.usuario.apellido,
      estado_cuenta: c.usuario.estado_cuenta,
    };
  }

  async getConductorEmpresa(idConductor: number): Promise<{ id_empresa: number; estado: string } | null> {
    return this.prisma.conductor.findUnique({
      where: { id_conductor: idConductor },
      select: { id_empresa: true, estado: true },
    });
  }

  async registrarFalloConductor(idConductor: number, bloqueadoHasta: Date | null): Promise<void> {
    await this.prisma.conductor.update({
      where: { id_conductor: idConductor },
      data: { intentos_fallidos: { increment: 1 }, bloqueado_hasta: bloqueadoHasta },
    });
  }

  async resetIntentosConductor(idConductor: number): Promise<void> {
    await this.prisma.conductor.update({
      where: { id_conductor: idConductor },
      data: { intentos_fallidos: 0, bloqueado_hasta: null },
    });
  }

  // --- OTP -------------------------------------------------------------------

  async contarOtpDesde(telefono: string, desde: Date): Promise<number> {
    return this.prisma.codigoOtp.count({ where: { telefono, creado_en: { gte: desde } } });
  }

  async ultimoOtpCreadoEn(telefono: string): Promise<Date | null> {
    const fila = await this.prisma.codigoOtp.findFirst({
      where: { telefono },
      orderBy: { creado_en: 'desc' },
      select: { creado_en: true },
    });
    return fila?.creado_en ?? null;
  }

  async crearOtp(telefono: string, codeHash: string, expira: Date): Promise<void> {
    await this.prisma.codigoOtp.create({
      data: { telefono, code_hash: codeHash, expira_en: expira },
    });
  }

  async getOtpVigente(
    telefono: string,
  ): Promise<{ id: number; code_hash: string; intentos: number; expira_en: Date } | null> {
    return this.prisma.codigoOtp.findFirst({
      where: { telefono, consumido: false },
      orderBy: { creado_en: 'desc' },
      select: { id: true, code_hash: true, intentos: true, expira_en: true },
    });
  }

  async incrementarIntentosOtp(id: number): Promise<void> {
    await this.prisma.codigoOtp.update({ where: { id }, data: { intentos: { increment: 1 } } });
  }

  /** Consumo ATÓMICO (A-09): true solo si ESTA llamada marcó `consumido` (count===1). */
  async consumirOtp(id: number): Promise<boolean> {
    const r = await this.prisma.codigoOtp.updateMany({
      where: { id, consumido: false },
      data: { consumido: true },
    });
    return r.count === 1;
  }
}

const selUsuario = {
  id_usuario: true,
  nombre: true,
  apellido: true,
  correo: true,
  contrasena: true,
  rol: true,
  estado_cuenta: true,
} as const;
