import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { findNeutralizationBlockers } from '../src/shared/neutralize-drivers-guard';
import { setTenantSession } from '../src/shared/tenant-session';

const BCRYPT_ROUNDS = 12;
const DISCARDED_PIN_BYTES = 32;

export interface NeutralizeSeedDriversInput {
  companyTaxId: string;
  nationalIds: string[];
  apply: boolean;
}

export interface NeutralizeSeedDriversResult {
  applied: boolean;
  driversMatched: number;
  driversWithActiveTrip: number;
  blockers: string[];
  driversNeutralized: number;
  sessionsRevoked: number;
}

export async function neutralizeSeedDrivers(
  prisma: PrismaClient,
  input: NeutralizeSeedDriversInput,
): Promise<NeutralizeSeedDriversResult> {
  const company = await prisma.company.findUnique({ where: { taxId: input.companyTaxId } });
  if (!company) throw new Error('No company found for the given --company-tax-id');

  const discardedPinHash = await bcrypt.hash(
    randomBytes(DISCARDED_PIN_BYTES).toString('hex'),
    BCRYPT_ROUNDS,
  );

  return prisma.$transaction(async (tx) => {
    await setTenantSession(tx, company.companyId);

    const matched = await tx.$queryRaw<Array<{ driver_id: number }>>`
      SELECT driver_id
        FROM fleet.driver
       WHERE company_id = ${company.companyId}
         AND national_id = ANY(${input.nationalIds}::text[])
    `;
    const driverIds = matched.map((row) => row.driver_id);

    const active = await tx.$queryRaw<Array<{ driver_id: number }>>`
      SELECT d.driver_id
        FROM fleet.driver d
       WHERE d.company_id = ${company.companyId}
         AND d.driver_id = ANY(${driverIds}::int[])
         AND (
           d.status = 'on_trip'
           OR EXISTS (
             SELECT 1
               FROM assignment.assignment a
               JOIN trips.trip_request t ON t.trip_request_id = a.trip_request_id
              WHERE a.driver_id = d.driver_id
                AND (
                  a.status IN ('created', 'notified', 'accepted')
                  OR t.status IN ('pending_assignment', 'assigned', 'driver_en_route', 'in_progress')
                )
           )
         )
    `;
    const blockers = findNeutralizationBlockers({
      expectedCount: new Set(input.nationalIds).size,
      matchedCount: driverIds.length,
      activeDriverCount: active.length,
    });
    const report = {
      driversMatched: driverIds.length,
      driversWithActiveTrip: active.length,
      blockers,
    };

    if (input.apply && blockers.length > 0) {
      throw new Error(`Aborted, nothing written: ${blockers.join('; ')}`);
    }
    if (!input.apply) {
      return { applied: false, ...report, driversNeutralized: 0, sessionsRevoked: 0 };
    }

    const driversNeutralized = await tx.$executeRaw`
      UPDATE fleet.driver
         SET pin = ${discardedPinHash},
             status = 'suspended',
             pin_delivered_at = NULL,
             failed_attempts = 0,
             blocked_until = NULL,
             updated_at = (now() AT TIME ZONE 'UTC')
       WHERE company_id = ${company.companyId}
         AND driver_id = ANY(${driverIds}::int[])
    `;
    const sessionsRevoked = await tx.$executeRaw`
      UPDATE auth.refresh_token
         SET revoked = true
       WHERE user_id = ANY(${driverIds}::int[])
         AND revoked = false
    `;

    return { applied: true, ...report, driversNeutralized, sessionsRevoked };
  });
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const companyTaxId = flag('company-tax-id');
  const nationalIds = flag('national-ids')
    ?.split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (!companyTaxId || !nationalIds || nationalIds.length === 0) {
    throw new Error(
      'Usage: neutralize-seed-drivers.ts --company-tax-id <tax id> --national-ids <id,id,...> [--apply]',
    );
  }

  const prisma = new PrismaClient();
  try {
    const result = await neutralizeSeedDrivers(prisma, {
      companyTaxId,
      nationalIds,
      apply: process.argv.includes('--apply'),
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e instanceof Error ? e.message : 'neutralize-seed-drivers failed');
    process.exitCode = 1;
  });
}
