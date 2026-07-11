// =============================================================================
// VoyYa — Seed de desarrollo (piloto Cootrayal · Yarumal).
// Ejecutar con el rol DUEÑO (DIRECT_URL) tras `prisma migrate` + 00_postgis_rls.sql,
// para que la RLS no bloquee los inserts de tablas tenant.
//
// Crea: municipio + polígono de cobertura, empresa activa, tarifa, parámetros,
// un pasajero, un ADMIN (correo+contraseña bcrypt) y tres conductores DISPONIBLES
// con taxi, ubicación y PIN bcrypt REAL (D-A08). Credenciales dev abajo.
//
// CREDENCIALES DE DESARROLLO (NO producción):
//   admin:      admin@voyya.co / Admin1234!
//   conductor:  cédula 71000001|71000002|71000003 · PIN 1234
//   pasajero:   OTP por teléfono (NoopSmsProvider registra el código en consola)
// =============================================================================

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const YARUMAL_ID = 1;
const BCRYPT_ROUNDS = 12;
const PIN_DEV = '1234'; // D-A02: PIN de 4 dígitos
const ADMIN_CORREO = 'admin@voyya.co';
const ADMIN_PASSWORD = 'Admin1234!';

// Polígono ~3 km alrededor del casco urbano de Yarumal (GeoJSON [lng, lat]).
const COBERTURA_YARUMAL = {
  type: 'Polygon',
  coordinates: [
    [
      [-75.45, 6.94],
      [-75.39, 6.94],
      [-75.39, 6.99],
      [-75.45, 6.99],
      [-75.45, 6.94],
    ],
  ],
};

const PARAMETROS: Array<[string, string]> = [
  ['radio_busqueda_km', '2'],
  ['radio_expansion_km', '6'],
  ['timeout_aceptacion_seg', '15'],
  ['max_reintentos_automaticos', '3'],
  ['ventana_desempate_viajes_horas', '3'],
  ['ventana_cancelacion_min', '2'],
  ['velocidad_promedio_kmh', '20'],
];

async function main(): Promise<void> {
  const pinHash = await bcrypt.hash(PIN_DEV, BCRYPT_ROUNDS);
  const adminHash = await bcrypt.hash(ADMIN_PASSWORD, BCRYPT_ROUNDS);

  // Municipio -----------------------------------------------------------------
  await prisma.municipio.upsert({
    where: { id_municipio: YARUMAL_ID },
    update: { poligono_cobertura: COBERTURA_YARUMAL },
    create: {
      id_municipio: YARUMAL_ID,
      nombre: 'Yarumal',
      departamento: 'Antioquia',
      poligono_cobertura: COBERTURA_YARUMAL,
      estado: 'activo',
    },
  });

  // Empresa (tenant) ----------------------------------------------------------
  const empresa = await prisma.empresa.upsert({
    where: { nit: '900123456-1' },
    update: { estado: 'activa' },
    create: {
      razon_social: 'Cootrayal',
      nit: '900123456-1',
      tipo: 'cooperativa',
      id_municipio: YARUMAL_ID,
      estado: 'activa',
    },
  });

  // Tarifa (placeholder — la oficial la fija Alcaldía/Cootrayal) ---------------
  const tarifa = await prisma.configuracionTarifa.findFirst({
    where: { id_municipio: YARUMAL_ID, tipo_servicio: 'taxi' },
  });
  if (!tarifa) {
    await prisma.configuracionTarifa.create({
      data: { id_municipio: YARUMAL_ID, tipo_servicio: 'taxi', tarifa_base: 8000 },
    });
  }

  // Parámetros del sistema ----------------------------------------------------
  for (const [clave, valor] of PARAMETROS) {
    await prisma.parametrosSistema.upsert({
      where: { clave_id_municipio: { clave, id_municipio: YARUMAL_ID } },
      update: { valor },
      create: { clave, valor, id_municipio: YARUMAL_ID },
    });
  }

  // Pasajero (GLOBAL) ---------------------------------------------------------
  const uPasajero = await prisma.usuario.upsert({
    where: { telefono: '3001112233' },
    update: {},
    create: {
      nombre: 'Ana',
      apellido: 'Pérez',
      telefono: '3001112233',
      rol: 'pasajero',
    },
  });
  await prisma.pasajero.upsert({
    where: { id_cliente: uPasajero.id_usuario },
    update: {},
    create: { id_cliente: uPasajero.id_usuario },
  });

  // Admin (correo + contraseña bcrypt) — D-A08 -------------------------------
  await prisma.usuario.upsert({
    where: { correo: ADMIN_CORREO },
    update: { contrasena: adminHash, rol: 'admin', estado_cuenta: 'activa' },
    create: {
      nombre: 'Admin',
      apellido: 'VoyYa',
      correo: ADMIN_CORREO,
      telefono: '3000000000',
      contrasena: adminHash,
      rol: 'admin',
    },
  });

  // Conductores DISPONIBLES con taxi + ubicación ------------------------------
  const conductores = [
    { cedula: '71000001', placa: 'ABC101', lat: 6.9642, lng: -75.419 },
    { cedula: '71000002', placa: 'ABC102', lat: 6.9655, lng: -75.417 },
    { cedula: '71000003', placa: 'ABC103', lat: 6.9701, lng: -75.421 },
  ];

  for (const [i, c] of conductores.entries()) {
    const taxi = await prisma.taxi.upsert({
      where: { placa: c.placa },
      update: { estado: 'activo' },
      create: { id_empresa: empresa.id_empresa, placa: c.placa, estado: 'activo' },
    });

    const u = await prisma.usuario.upsert({
      where: { telefono: `30022200${i + 1}` },
      update: {},
      create: {
        nombre: `Conductor${i + 1}`,
        apellido: 'Yarumal',
        telefono: `30022200${i + 1}`,
        rol: 'conductor',
      },
    });

    await prisma.conductor.upsert({
      where: { id_conductor: u.id_usuario },
      update: {
        pin: pinHash, // D-A08: reemplaza el placeholder inválido por bcrypt real
        estado: 'disponible',
        lat_actual: c.lat,
        lng_actual: c.lng,
        ubicacion_actualizada_en: new Date(),
        id_taxi_actual: taxi.id_taxi,
      },
      create: {
        id_conductor: u.id_usuario,
        id_empresa: empresa.id_empresa,
        cedula: c.cedula,
        pin: pinHash, // bcrypt real (PIN dev = 1234)
        estado: 'disponible',
        lat_actual: c.lat,
        lng_actual: c.lng,
        ubicacion_actualizada_en: new Date(),
        id_taxi_actual: taxi.id_taxi,
      },
    });
  }

  // eslint-disable-next-line no-console
  console.log('Seed completado: Yarumal + Cootrayal + 3 conductores disponibles.');
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
