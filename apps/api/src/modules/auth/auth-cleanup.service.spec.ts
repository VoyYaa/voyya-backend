import 'reflect-metadata';
import { SCHEDULED_JOBS } from '../../infrastructure/observability/scheduled-jobs';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';

function statementOfCall(args: unknown[]): { text: string; values: unknown[] } {
  const [strings, ...values] = args as [string[], ...unknown[]];
  const text = strings.reduce(
    (accumulated, part, index) => `${accumulated}${part}${index < values.length ? `$${index + 1}` : ''}`,
    '',
  );
  return { text, values };
}

const mockLock = {
  keys: [] as number[],
  statements: [] as Array<{ text: string; values: unknown[] }>,
  tx: {
    $executeRaw: jest.fn(async (...args: unknown[]) => {
      mockLock.statements.push(statementOfCall(args));
      return 0;
    }),
  },
};

jest.mock('../../infrastructure/prisma/advisory-lock', () => ({
  runWithAdvisoryLock: async (
    _prisma: unknown,
    key: number,
    work: (tx: unknown) => Promise<void>,
  ): Promise<boolean> => {
    mockLock.keys.push(key);
    await work(mockLock.tx);
    return true;
  },
}));

import { AuthCleanupService } from './auth-cleanup.service';
import { otpRetentionSeconds } from './otp-policy';

beforeEach(() => {
  mockLock.keys = [];
  mockLock.statements = [];
});

describe('AuthCleanupService (ADR-035 5): retention by age', () => {
  it('runs inside the advisory lock 91001', async () => {
    await new AuthCleanupService({} as PrismaService).cleanup();

    expect(mockLock.keys).toEqual([91_001]);
  });

  it('deletes the OTP rows older than the retention window by created_at, not by expired or consumed', async () => {
    await new AuthCleanupService({} as PrismaService).cleanup();

    const otp = mockLock.statements.find((statement) => statement.text.includes('auth.otp_code'));
    expect(otp?.text).toContain('DELETE FROM auth.otp_code');
    expect(otp?.text).toContain('created_at <=');
    expect(otp?.text).toContain("timezone('utc', now())");
    expect(otp?.text).not.toContain('consumed');
    expect(otp?.text).not.toContain('expires_at');
    expect(otp?.values).toEqual([otpRetentionSeconds()]);
  });

  it('keeps the refresh-token cleanup as it was', async () => {
    await new AuthCleanupService({} as PrismaService).cleanup();

    const refresh = mockLock.statements.find((statement) => statement.text.includes('auth.refresh_token'));
    expect(refresh?.text).toContain('expires_at < now() OR revoked = true');
  });

  it('keeps the hourly schedule and the job name', () => {
    const options = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', AuthCleanupService.prototype.cleanup) as {
      cronTime: string;
      name: string;
    };

    expect(options).toMatchObject({ cronTime: SCHEDULED_JOBS.authCleanup.cron, name: 'auth-cleanup' });
  });
});
