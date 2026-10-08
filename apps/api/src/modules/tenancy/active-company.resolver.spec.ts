import { Logger } from '@nestjs/common';
import { ActiveCompanyResolver } from './active-company.resolver';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';

function fakePrisma(companies: Array<{ companyId: number }>): {
  prisma: PrismaService;
  findMany: jest.Mock;
} {
  const findMany = jest.fn().mockResolvedValue(companies);
  const prisma = { company: { findMany } } as unknown as PrismaService;
  return { prisma, findMany };
}

describe('ActiveCompanyResolver.resolve', () => {
  it('one active company in the municipality -> resolves its companyId', async () => {
    const { prisma } = fakePrisma([{ companyId: 7 }]);
    const resolver = new ActiveCompanyResolver(prisma);

    await expect(resolver.resolve(1)).resolves.toBe(7);
  });

  it('no active company in the municipality -> null', async () => {
    const { prisma } = fakePrisma([]);
    const resolver = new ActiveCompanyResolver(prisma);

    await expect(resolver.resolve(1)).resolves.toBeNull();
  });

  it('two active companies -> deterministically resolves the lower companyId (tiebreak, ADR-018 §2/§8 A-2)', async () => {
    const { prisma } = fakePrisma([{ companyId: 3 }, { companyId: 9 }]);
    const resolver = new ActiveCompanyResolver(prisma);

    await expect(resolver.resolve(1)).resolves.toBe(3);
  });

  it('queries only active companies of the given municipality, ordered by companyId ascending, capped at 2', async () => {
    const { prisma, findMany } = fakePrisma([{ companyId: 5 }]);
    const resolver = new ActiveCompanyResolver(prisma);

    await resolver.resolve(42);

    expect(findMany).toHaveBeenCalledWith({
      where: { municipalityId: 42, status: 'active' },
      orderBy: { companyId: 'asc' },
      select: { companyId: true },
      take: 2,
    });
  });
});

describe('ActiveCompanyResolver multiple-active warning', () => {
  const TWO = [{ companyId: 3 }, { companyId: 9 }];
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('logs a warn (not an error) naming the municipality and companies, once for repeated calls', async () => {
    const resolver = new ActiveCompanyResolver(fakePrisma(TWO).prisma);
    for (let i = 0; i < 50; i += 1) await resolver.resolve(1);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Multiple active companies in municipality=1: 3,9');
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps one signal per municipality', async () => {
    const resolver = new ActiveCompanyResolver(fakePrisma(TWO).prisma);
    await resolver.resolve(1);
    await resolver.resolve(2);
    await resolver.resolve(1);

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns again after the window elapses', async () => {
    const resolver = new ActiveCompanyResolver(fakePrisma(TWO).prisma);
    await resolver.resolve(1);
    jest.advanceTimersByTime(61 * 60_000);
    await resolver.resolve(1);

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not warn with a single active company', async () => {
    const resolver = new ActiveCompanyResolver(fakePrisma([{ companyId: 3 }]).prisma);
    await resolver.resolve(1);

    expect(warn).not.toHaveBeenCalled();
  });
});
