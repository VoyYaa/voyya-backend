import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { resolveSeedAdminPassword } from '../src/shared/seed-admin-password';

const prisma = new PrismaClient();

const YARUMAL_ID = 1;
const BCRYPT_ROUNDS = 12;
const DEV_PIN = '1234';
const ADMIN_EMAIL = 'admin@voyya.co';
const ADMIN_PASSWORD = resolveSeedAdminPassword(process.env);

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

const PARAMETERS: Array<[string, string]> = [
  ['search_radius_km', '2'],
  ['expansion_radius_km', '6'],
  ['acceptance_timeout_sec', '15'],
  ['max_auto_retries', '3'],
  ['tiebreak_window_hours', '3'],
  ['cancellation_window_min', '2'],
  ['avg_speed_kmh', '20'],
  ['no_show_grace_min', '5'],
  ['location_stale_min', '15'],
];

async function main(): Promise<void> {
  const pinHash = await bcrypt.hash(DEV_PIN, BCRYPT_ROUNDS);
  const adminHash = await bcrypt.hash(ADMIN_PASSWORD, BCRYPT_ROUNDS);

  await prisma.municipality.upsert({
    where: { municipalityId: YARUMAL_ID },
    update: { coveragePolygon: YARUMAL_COVERAGE },
    create: {
      municipalityId: YARUMAL_ID,
      name: 'Yarumal',
      department: 'Antioquia',
      coveragePolygon: YARUMAL_COVERAGE,
      status: 'active',
    },
  });

  const company = await prisma.company.upsert({
    where: { taxId: '900123456-1' },
    update: { status: 'active' },
    create: {
      legalName: 'Cootrayal',
      taxId: '900123456-1',
      type: 'cooperative',
      municipalityId: YARUMAL_ID,
      status: 'active',
    },
  });

  const fareConfig = await prisma.fareConfig.findFirst({
    where: { companyId: company.companyId, serviceType: 'taxi' },
  });
  if (!fareConfig) {
    await prisma.fareConfig.create({
      data: { companyId: company.companyId, serviceType: 'taxi', baseFare: 8000 },
    });
  }

  for (const [key, value] of PARAMETERS) {
    await prisma.systemParameter.upsert({
      where: { key_companyId: { key, companyId: company.companyId } },
      update: { value },
      create: { key, value, companyId: company.companyId },
    });
  }

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
      },
    });
  }

  // eslint-disable-next-line no-console
  console.log('Seed completed: Yarumal + Cootrayal + 3 available drivers.');
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
