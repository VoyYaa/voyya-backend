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

describe('PrismaService.runAsPlatform (ADR-032 section 4.4, MD-11)', () => {
  function serviceWithTransaction(): { service: PrismaService; executeRaw: jest.Mock } {
    const service = new PrismaService(fakeEnv());
    const executeRaw = jest.fn().mockResolvedValue(1);
    const tx = { $executeRaw: executeRaw };
    jest
      .spyOn(service, '$transaction')
      .mockImplementation(((fn: (client: unknown) => Promise<unknown>) => fn(tx)) as never);
    return { service, executeRaw };
  }

  it('sets app.platform_session to on, local to the transaction, before running the callback', async () => {
    const { service, executeRaw } = serviceWithTransaction();
    const order: string[] = [];
    executeRaw.mockImplementation(async () => {
      order.push('set_config');
      return 1;
    });

    const result = await service.runAsPlatform(async () => {
      order.push('callback');
      return 'done';
    });

    expect(result).toBe('done');
    expect(order).toEqual(['set_config', 'callback']);
    const [strings] = executeRaw.mock.calls[0] as [TemplateStringsArray];
    expect(strings.join('?')).toBe("SELECT set_config('app.platform_session', 'on', true)");
  });
});
