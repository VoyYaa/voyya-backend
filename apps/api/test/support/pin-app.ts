import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { SMS_PROVIDER } from '../../src/modules/assignment/ports/sms-provider.port';
import { AllExceptionsFilter } from '../../src/shared/all-exceptions.filter';

export interface PinApp {
  app: INestApplication;
  prisma: PrismaService;
  jwt: JwtService;
  sms: { send: jest.Mock };
  companyId: number;
  adminAuth: string;
}

export interface PendingDriver {
  driverId: number;
  nationalId: string;
  phone: string;
  temporaryPin: string;
}

interface PendingDriverOptions {
  pinMustChange?: boolean;
  temporaryPinExpiresAt?: Date | null;
  pinDeliveredAt?: Date | null;
  temporaryPin?: string;
}

const BCRYPT_ROUNDS_FOR_TESTS = 10;
const MUNICIPALITY_ID = 9131;
const COMPANY_TAX_ID = '_pin-change-co';

export async function bootPinApp(): Promise<PinApp> {
  const url = process.env.PG_TEST_URL;
  process.env.DATABASE_URL = url;
  process.env.LOGIN_MAX_ATTEMPTS = '3';
  process.env.LOGIN_BLOCK_MINUTES = '15';

  const sms = { send: jest.fn().mockResolvedValue(undefined) };
  const { AppModule } = await import('../../src/app.module');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SMS_PROVIDER)
    .useValue(sms)
    .compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  const prisma = moduleRef.get(PrismaService);
  const jwt = moduleRef.get(JwtService, { strict: false });

  const municipality = await prisma.municipality.upsert({
    where: { municipalityId: MUNICIPALITY_ID },
    update: {},
    create: {
      municipalityId: MUNICIPALITY_ID,
      name: '_PinChangeMuni',
      department: 'Test',
      coveragePolygon: {
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
      },
      status: 'active',
    },
  });
  const company = await prisma.company.upsert({
    where: { taxId: COMPANY_TAX_ID },
    update: { status: 'active' },
    create: {
      legalName: '_PinChangeCo',
      taxId: COMPANY_TAX_ID,
      type: 'cooperative',
      municipalityId: municipality.municipalityId,
      status: 'active',
    },
  });

  const adminToken = jwt.sign({ sub: 1, role: 'admin', type: 'access', company_id: company.companyId });
  return { app, prisma, jwt, sms, companyId: company.companyId, adminAuth: `Bearer ${adminToken}` };
}

export async function createDriver(
  ctx: Pick<PinApp, 'prisma' | 'companyId'>,
  options: PendingDriverOptions = {},
): Promise<PendingDriver> {
  const nationalId = `8${randomInt(10_000_000, 99_999_999)}`;
  const phone = `3${randomInt(100_000_000, 999_999_999)}`;
  const temporaryPin = options.temporaryPin ?? String(randomInt(100_000, 999_999));

  const user = await ctx.prisma.user.create({
    data: { firstName: 'Pin', lastName: 'Driver', phone, role: 'driver' },
  });
  await ctx.prisma.runInTenant(ctx.companyId, async (tx) =>
    tx.driver.create({
      data: {
        driverId: user.userId,
        companyId: ctx.companyId,
        nationalId,
        pin: await bcrypt.hash(temporaryPin, BCRYPT_ROUNDS_FOR_TESTS),
        status: 'off_shift',
        pinDeliveredAt: options.pinDeliveredAt === undefined ? new Date() : options.pinDeliveredAt,
        ...(options.pinMustChange === undefined ? {} : { pinMustChange: options.pinMustChange }),
        temporaryPinExpiresAt:
          options.temporaryPinExpiresAt === undefined
            ? new Date(Date.now() + 3_600_000)
            : options.temporaryPinExpiresAt,
      },
    }),
  );
  return { driverId: user.userId, nationalId, phone, temporaryPin };
}

export function pendingToken(ctx: Pick<PinApp, 'jwt' | 'companyId'>, driverId: number): string {
  return ctx.jwt.sign({
    sub: driverId,
    role: 'driver',
    type: 'access',
    company_id: ctx.companyId,
    pin_change_required: true,
  });
}

export function personalToken(ctx: Pick<PinApp, 'jwt' | 'companyId'>, driverId: number): string {
  return ctx.jwt.sign({ sub: driverId, role: 'driver', type: 'access', company_id: ctx.companyId });
}

export async function readDriver(ctx: Pick<PinApp, 'prisma' | 'companyId'>, driverId: number) {
  return ctx.prisma.runInTenant(ctx.companyId, (tx) =>
    tx.driver.findUniqueOrThrow({ where: { driverId } }),
  );
}
