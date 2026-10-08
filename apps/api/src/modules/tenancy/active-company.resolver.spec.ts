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
