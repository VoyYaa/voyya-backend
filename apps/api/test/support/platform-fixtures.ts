import type { JwtService } from '@nestjs/jwt';
import type { ServiceType } from '@prisma/client';
import { randomInt } from 'node:crypto';
import type { PrismaService } from '../../src/infrastructure/prisma/prisma.service';

export const SQUARE = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  ],
};

export function uniqueSuffix(): string {
  return `${Date.now()}${randomInt(100_000, 999_999)}`;
}

export async function createPlatformAdmin(
  prisma: PrismaService,
  jwt: JwtService,
  tag: string,
): Promise<{ userId: number; auth: string }> {
  const user = await prisma.user.create({
    data: {
      firstName: '_Platform',
      lastName: 'Admin',
      phone: `_platadm-${tag}-${uniqueSuffix()}`,
      role: 'platform_admin',
      companyId: null,
    },
  });
  const token = jwt.sign({ sub: user.userId, role: 'platform_admin', type: 'access' });
  return { userId: user.userId, auth: `Bearer ${token}` };
}

export function tokenFor(
  jwt: JwtService,
  role: 'admin' | 'operator' | 'platform_admin',
  companyId: number | null,
  sub = 910_000 + randomInt(1, 80_000),
): string {
  const claims = { sub, role, type: 'access', ...(companyId !== null ? { company_id: companyId } : {}) };
  return `Bearer ${jwt.sign(claims)}`;
}

const RESERVED_DANE_DIGITS = 900;

function reservedDaneCode(): string {
  return `00${String(randomInt(0, RESERVED_DANE_DIGITS)).padStart(3, '0')}`;
}

export async function createMunicipality(
  prisma: PrismaService,
  namePrefix: string,
  options: { status?: 'active' | 'catalog'; daneCode?: string } = {},
): Promise<number> {
  const status = options.status ?? 'active';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const daneCode = options.daneCode ?? (status === 'catalog' ? reservedDaneCode() : undefined);
    try {
      const municipality = await prisma.municipality.create({
        data: {
          name: `${namePrefix}-${uniqueSuffix()}`,
          department: 'Test',
          status,
          ...(status === 'active' ? { coveragePolygon: SQUARE } : {}),
          ...(daneCode ? { daneCode, daneType: 'municipality' } : {}),
        },
      });
      return municipality.municipalityId;
    } catch (error) {
      const duplicatedDaneCode = (error as { code?: string }).code === 'P2002' && options.daneCode === undefined;
      if (!duplicatedDaneCode) throw error;
    }
  }
  throw new Error('No free reserved DANE code for the municipality fixture');
}

export interface CompanyFixtureOptions {
  legalName?: string;
  status?: 'pending' | 'active' | 'suspended' | 'rejected';
  serviceTypes?: ServiceType[];
  publicName?: string | null;
}

export async function createCompany(
  prisma: PrismaService,
  municipalityId: number,
  options: CompanyFixtureOptions = {},
): Promise<number> {
  const suffix = uniqueSuffix();
  const company = await prisma.company.create({
    data: {
      legalName: options.legalName ?? `_Co-${suffix}`,
      taxId: `_co-${suffix}`,
      type: 'cooperative',
      municipalityId,
      status: options.status ?? 'pending',
      vehicleCount: 10,
      contactEmail: `contact-${suffix}@voyya-e2e.test`,
      contactFirstName: '_Contact',
      contactLastName: `First${suffix}`,
      contactPhone: `_contact-${suffix}`,
      ...(options.serviceTypes ? { serviceTypes: options.serviceTypes } : {}),
      ...(options.publicName !== undefined ? { publicName: options.publicName } : {}),
    },
  });
  return company.companyId;
}

export async function seedOpenFare(
  prisma: PrismaService,
  municipalityId: number,
  serviceType: ServiceType = 'taxi',
  baseFare = 9000,
): Promise<number> {
  const fare = await prisma.runAsPlatform((tx) =>
    tx.$queryRaw<Array<{ id: number }>>`
      INSERT INTO trips.municipality_fare
        (municipality_id, service_type, base_fare, night_surcharge_pct, holiday_surcharge_pct, origin, valid_from)
      VALUES (${municipalityId}, ${serviceType}::trips."ServiceType", ${baseFare}, 20, 15, 'platform_edit', now() AT TIME ZONE 'UTC')
      RETURNING municipality_fare_id AS id`,
  );
  return fare[0]?.id ?? 0;
}

export async function seedCommission(
  prisma: PrismaService,
  companyId: number,
  commissionPct = 8,
): Promise<number> {
  const rows = await prisma.runAsPlatform((tx) =>
    tx.$queryRaw<Array<{ id: number }>>`
      INSERT INTO tenancy.company_commission (company_id, commission_pct, origin, valid_from)
      VALUES (${companyId}, ${commissionPct}, 'platform_edit', now() AT TIME ZONE 'UTC')
      RETURNING company_commission_id AS id`,
  );
  return rows[0]?.id ?? 0;
}

export async function openFares(prisma: PrismaService, municipalityId: number, serviceType: ServiceType = 'taxi') {
  return prisma.municipalityFare.findMany({ where: { municipalityId, serviceType, validTo: null } });
}

export async function commissionsOf(prisma: PrismaService, companyId: number) {
  return prisma.runAsPlatform((tx) => tx.companyCommission.findMany({ where: { companyId } }));
}
