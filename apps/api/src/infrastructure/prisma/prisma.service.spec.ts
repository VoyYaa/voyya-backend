import type { EnvService } from '../../config/env.service';
import { PrismaService } from './prisma.service';

function fakeEnv(overrides: Record<string, unknown> = {}): EnvService {
  const values: Record<string, unknown> = {
    DB_CONNECT_MAX_ATTEMPTS: 3,
    DB_CONNECT_RETRY_BASE_MS: 1,
    DATABASE_URL: 'postgresql://u:p@localhost:5432/voyya_test?schema=public',
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as EnvService;
}

describe('PrismaService connection backoff', () => {
  it('retries $connect with backoff and succeeds before exhausting attempts', async () => {
    const service = new PrismaService(fakeEnv());
    const connect = jest
      .spyOn(service, '$connect')
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(undefined);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting DB_CONNECT_MAX_ATTEMPTS', async () => {
    const service = new PrismaService(fakeEnv({ DB_CONNECT_MAX_ATTEMPTS: 2 }));
    const error = new Error('ECONNREFUSED');
    const connect = jest.spyOn(service, '$connect').mockRejectedValue(error);

    await expect(service.onModuleInit()).rejects.toThrow('ECONNREFUSED');
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('succeeds on the first attempt without retrying', async () => {
    const service = new PrismaService(fakeEnv());
    const connect = jest.spyOn(service, '$connect').mockResolvedValueOnce(undefined);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
