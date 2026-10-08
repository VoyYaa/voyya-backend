import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

interface FreshPassengerNames {
  firstName?: string;
  lastName?: string;
}

export async function createFreshPassenger(
  prisma: PrismaClient,
  names: FreshPassengerNames = {},
): Promise<number> {
  const user = await prisma.user.create({
    data: {
      firstName: names.firstName ?? '_Fixture',
      lastName: names.lastName ?? 'Passenger',
      phone: `_fx-${randomUUID()}`,
      role: 'passenger',
    },
  });
  await prisma.passenger.create({ data: { passengerId: user.userId } });
  return user.userId;
}
