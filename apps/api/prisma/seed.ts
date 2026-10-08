import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { resolveSeedAdminPassword } from '../src/shared/seed-admin-password';
import { assertSeedDestinationIsEmpty } from '../src/shared/seed-destination';
import { resolveSeedDriverPin } from '../src/shared/seed-target';

const prisma = new PrismaClient();

const YARUMAL_DANE_CODE = '05887';
const BCRYPT_ROUNDS = 12;
const DRIVER_PIN = resolveSeedDriverPin(process.env);
const ADMIN_EMAIL = 'admin@voyya.co';
const ADMIN_PASSWORD = resolveSeedAdminPassword(process.env);
const PLATFORM_ADMIN_EMAIL = 'plataforma@voyya.co';
const PLATFORM_ADMIN_PASSWORD = resolveSeedAdminPassword(process.env);

const YARUMAL_COVERAGE = {
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

const MUNICIPALITY_PARAMETERS = {
  searchRadiusKm: 2,
  expansionRadiusKm: 6,
  acceptanceTimeoutSec: 15,
  maxAutoRetries: 3,
  tiebreakWindowHours: 3,
  cancellationWindowMin: 2,
  avgSpeedKmh: 20,
  noShowGraceMin: 5,
  locationStaleMin: 15,
};
const SEED_BASE_FARE = 8000;
const SEED_NIGHT_SURCHARGE_PCT = 20;
const SEED_HOLIDAY_SURCHARGE_PCT = 15;
const SEED_COMMISSION_PCT = 8;

async function countRows(table: 'auth."user"' | 'tenancy.company'): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ total: number }>>(
    `SELECT count(*)::int AS total FROM ${table}`,
  );
  return rows.reduce((sum, row) => sum + row.total, 0);
}

async function assertEmptyDestination(): Promise<void> {
  assertSeedDestinationIsEmpty({
    userCount: await countRows('auth."user"'),
    companyCount: await countRows('tenancy.company'),
  });
}

async function seedMunicipalityConfig(
  municipalityId: number,
  companyId: number,
  authorId: number,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_session', 'on', true)`;

    const openFare = await tx.municipalityFare.findFirst({
      where: { municipalityId, serviceType: 'taxi', validTo: null },
    });
    if (!openFare) {
      await tx.municipalityFare.create({
        data: {
          municipalityId,
          serviceType: 'taxi',
          baseFare: SEED_BASE_FARE,
          nightSurchargePct: SEED_NIGHT_SURCHARGE_PCT,
          holidaySurchargePct: SEED_HOLIDAY_SURCHARGE_PCT,
          origin: 'platform_edit',
          createdBy: authorId,
        },
      });
    }

    const openParams = await tx.municipalityOperationalParams.findFirst({
      where: { municipalityId, serviceType: 'taxi', validTo: null },
    });
    if (!openParams) {
      await tx.municipalityOperationalParams.create({
        data: {
          municipalityId,
          serviceType: 'taxi',
          ...MUNICIPALITY_PARAMETERS,
          origin: 'platform_edit',
          createdBy: authorId,
        },
      });
    }

    const openCommission = await tx.companyCommission.findFirst({
      where: { companyId, validTo: null },
    });
    if (!openCommission) {
      await tx.companyCommission.create({
        data: {
          companyId,
          commissionPct: SEED_COMMISSION_PCT,
          origin: 'platform_edit',
          createdBy: authorId,
        },
      });
    }
  });
}

async function main(): Promise<void> {
  await assertEmptyDestination();
  const pinHash = await bcrypt.hash(DRIVER_PIN, BCRYPT_ROUNDS);
  const adminHash = await bcrypt.hash(ADMIN_PASSWORD, BCRYPT_ROUNDS);
  const platformAdminHash = await bcrypt.hash(PLATFORM_ADMIN_PASSWORD, BCRYPT_ROUNDS);

  const yarumal = await prisma.municipality.findUnique({ where: { daneCode: YARUMAL_DANE_CODE } });
  if (!yarumal) {
    throw new Error('The DIVIPOLA catalog is not loaded (no municipality 05887): run db:release first');
  }
  await prisma.municipality.update({
    where: { municipalityId: yarumal.municipalityId },
    data: { status: 'active', coveragePolygon: YARUMAL_COVERAGE },
  });

  const platformAdmin = await prisma.user.upsert({
    where: { email: PLATFORM_ADMIN_EMAIL },
    update: { passwordHash: platformAdminHash, role: 'platform_admin', accountStatus: 'active' },
    create: {
      firstName: 'Plataforma',
      lastName: 'VoyYa',
      email: PLATFORM_ADMIN_EMAIL,
      phone: '3000000001',
      passwordHash: platformAdminHash,
      role: 'platform_admin',
      companyId: null,
    },
  });

  const company = await prisma.company.upsert({
    where: { taxId: '900123456-1' },
    update: { status: 'active' },
    create: {
      legalName: 'Cootrayal',
      taxId: '900123456-1',
      type: 'cooperative',
      municipalityId: yarumal.municipalityId,
      status: 'active',
    },
  });

  await seedMunicipalityConfig(yarumal.municipalityId, company.companyId, platformAdmin.userId);

  const passengerUser = await prisma.user.upsert({
    where: { phone: '3001112233' },
    update: {},
    create: {
      firstName: 'Ana',
      lastName: 'Pérez',
      phone: '3001112233',
      role: 'passenger',
    },
  });
  await prisma.passenger.upsert({
    where: { passengerId: passengerUser.userId },
    update: {},
    create: { passengerId: passengerUser.userId },
  });

  await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {
      passwordHash: adminHash,
      role: 'admin',
      accountStatus: 'active',
      companyId: company.companyId,
    },
    create: {
      firstName: 'Admin',
      lastName: 'VoyYa',
      email: ADMIN_EMAIL,
      phone: '3000000000',
      passwordHash: adminHash,
      role: 'admin',
      companyId: company.companyId,
    },
  });

  const drivers = [
    { nationalId: '71000001', plate: 'ABC101', lat: 6.9642, lng: -75.419 },
    { nationalId: '71000002', plate: 'ABC102', lat: 6.9655, lng: -75.417 },
    { nationalId: '71000003', plate: 'ABC103', lat: 6.9701, lng: -75.421 },
  ];

  for (const [i, d] of drivers.entries()) {
    const vehicle = await prisma.vehicle.upsert({
      where: { plate: d.plate },
      update: { status: 'active', model: 'Chevrolet Spark' },
      create: {
        companyId: company.companyId,
        plate: d.plate,
        model: 'Chevrolet Spark',
        status: 'active',
      },
    });

    const u = await prisma.user.upsert({
      where: { phone: `30022200${i + 1}` },
      update: {},
      create: {
        firstName: `Conductor${i + 1}`,
        lastName: 'Yarumal',
        phone: `30022200${i + 1}`,
        role: 'driver',
      },
    });

    await prisma.driver.upsert({
      where: { driverId: u.userId },
      update: {
        pin: pinHash,
        status: 'available',
        currentLat: d.lat,
        currentLng: d.lng,
        locationUpdatedAt: new Date(),
        currentVehicleId: vehicle.vehicleId,
        pinDeliveredAt: new Date(),
        pinMustChange: false,
      },
      create: {
        driverId: u.userId,
        companyId: company.companyId,
        nationalId: d.nationalId,
        pin: pinHash,
        status: 'available',
        currentLat: d.lat,
        currentLng: d.lng,
        locationUpdatedAt: new Date(),
        currentVehicleId: vehicle.vehicleId,
        pinDeliveredAt: new Date(),
        pinMustChange: false,
      },
    });
  }

  // eslint-disable-next-line no-console
  console.log('Seed completed: Yarumal (05887) + Cootrayal + municipality fare, parameters and commission + 3 available drivers.');
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
