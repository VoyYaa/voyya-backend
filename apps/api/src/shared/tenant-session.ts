import type { Prisma } from '@prisma/client';

export async function setTenantSession(tx: Prisma.TransactionClient, companyId: number): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
}
