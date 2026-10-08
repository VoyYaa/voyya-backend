import { DispatchCompaniesResolver } from './dispatch-companies.resolver';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';

function fakePrisma(companies: Array<{ companyId: number }>): {
  prisma: PrismaService;
  findMany: jest.Mock;
} {
  const findMany = jest.fn().mockResolvedValue(companies);
  const prisma = { company: { findMany } } as unknown as PrismaService;
  return { prisma, findMany };
}

describe('DispatchCompaniesResolver.resolve', () => {
  it('returns every active company of the municipality ordered by companyId', async () => {
    const { prisma } = fakePrisma([{ companyId: 3 }, { companyId: 9 }]);
    const resolver = new DispatchCompaniesResolver(prisma);

    await expect(resolver.resolve(1)).resolves.toEqual([3, 9]);
  });

  it('no active company -> empty list', async () => {
    const { prisma } = fakePrisma([]);
    const resolver = new DispatchCompaniesResolver(prisma);

    await expect(resolver.resolve(1)).resolves.toEqual([]);
  });

  it('queries only active companies of the municipality, ordered by companyId ascending', async () => {
    const { prisma, findMany } = fakePrisma([{ companyId: 5 }]);
    const resolver = new DispatchCompaniesResolver(prisma);

    await resolver.resolve(42);

    expect(findMany).toHaveBeenCalledWith({
      where: { municipalityId: 42, status: 'active', AND: [] },
      orderBy: { companyId: 'asc' },
      select: { companyId: true },
    });
  });

  it('filters by the service the company offers when a service is given', async () => {
    const { prisma, findMany } = fakePrisma([]);
    const resolver = new DispatchCompaniesResolver(prisma);

    await resolver.resolve(1, { serviceType: 'taxi' });

    expect(findMany.mock.calls[0]?.[0].where.serviceTypes).toEqual({ has: 'taxi' });
  });

  it('narrows to the requested company and still honours the exclusion', async () => {
    const { prisma, findMany } = fakePrisma([]);
    const resolver = new DispatchCompaniesResolver(prisma);

    await resolver.resolve(1, { requestedCompanyId: 7, excludeCompanyId: 8 });

    expect(findMany.mock.calls[0]?.[0].where.AND).toEqual([{ companyId: 7 }, { companyId: { not: 8 } }]);
  });

  it('a null requested company means "any company"', async () => {
    const { prisma, findMany } = fakePrisma([]);
    const resolver = new DispatchCompaniesResolver(prisma);

    await resolver.resolve(1, { requestedCompanyId: null });

    expect(findMany.mock.calls[0]?.[0].where.AND).toEqual([]);
  });

  it('uses the transaction client when one is given', async () => {
    const outer = fakePrisma([]);
    const inner = fakePrisma([{ companyId: 2 }]);
    const resolver = new DispatchCompaniesResolver(outer.prisma);

    await resolver.resolve(1, { tx: inner.prisma as never });

    expect(inner.findMany).toHaveBeenCalledTimes(1);
    expect(outer.findMany).not.toHaveBeenCalled();
  });
});
