import type { Prisma } from '@prisma/client';
import type { AssignmentStatus } from '@voyyaa/shared';
import { AssignmentRepository } from './assignment.repository';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';

function buildTx(row: { assignmentId: number } | null): {
  tx: Prisma.TransactionClient;
  findFirst: jest.Mock;
} {
  const findFirst = jest.fn().mockResolvedValue(row);
  return { tx: { assignment: { findFirst } } as unknown as Prisma.TransactionClient, findFirst };
}

describe('AssignmentRepository.getAssignmentForDriver (V-01: caller-controlled status allow-list)', () => {
  it('forwards exactly the statuses passed by the caller, tenant-scoped', async () => {
    const { tx, findFirst } = buildTx({ assignmentId: 9 });
    const repo = new AssignmentRepository({} as unknown as PrismaService);
    const allow: AssignmentStatus[] = ['accepted'];

    const result = await repo.getAssignmentForDriver(tx, 1, 2, 3, allow);

    expect(result).toEqual({ assignmentId: 9 });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tripRequestId: 1,
          driverId: 2,
          companyId: 3,
          status: { in: ['accepted'] },
        }),
      }),
    );
  });

  it('never injects "cancelled" on its own when the caller asks only for ["accepted"] (V-01 regression guard)', async () => {
    const { tx, findFirst } = buildTx(null);
    const repo = new AssignmentRepository({} as unknown as PrismaService);

    await repo.getAssignmentForDriver(tx, 1, 2, 3, ['accepted']);

    const where = (
      findFirst.mock.calls[0]?.[0] as { where: { status: { in: AssignmentStatus[] } } }
    ).where;
    expect(where.status.in).not.toContain('cancelled');
  });

  it('honors a different allow-list verbatim (e.g. ["completed"] for cash-collected)', async () => {
    const { tx, findFirst } = buildTx(null);
    const repo = new AssignmentRepository({} as unknown as PrismaService);

    await repo.getAssignmentForDriver(tx, 1, 2, 3, ['completed']);

    const where = (
      findFirst.mock.calls[0]?.[0] as { where: { status: { in: AssignmentStatus[] } } }
    ).where;
    expect(where.status.in).toEqual(['completed']);
  });
});
