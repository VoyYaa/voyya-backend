import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuthRepository } from './auth.repository';
import type { OtpIssuancePolicy } from './otp-policy';

const policy: OtpIssuancePolicy = {
  ttlSec: 300,
  cooldownSec: 30,
  hourlyLimit: 5,
  hourlyWindowSec: 3_600,
  dailyLimit: 10,
  dailyWindowSec: 86_400,
  globalLimit: 300,
};

const PHONE = '3001112233';
const HASH = '$2a$10$not-a-real-hash-value-for-the-unit-test';

interface Statement {
  text: string;
  values: unknown[];
}

function statementOfCall(args: unknown[]): Statement {
  const [first, ...values] = args;
  if (Array.isArray(first)) {
    const strings = first as string[];
    const text = strings.reduce(
      (accumulated, part, index) => `${accumulated}${part}${index < values.length ? `$${index + 1}` : ''}`,
      '',
    );
    return { text, values };
  }
  const prepared = first as { text: string; values: unknown[] };
  return { text: prepared.text, values: prepared.values };
}

function transactionHarness(rowsByStatement: Array<Array<Record<string, unknown>>>) {
  const txStatements: Statement[] = [];
  const tx = {
    $queryRaw: jest.fn(async (...args: unknown[]) => {
      txStatements.push(statementOfCall(args));
      return rowsByStatement[txStatements.length - 1] ?? [];
    }),
    $executeRaw: jest.fn(async (...args: unknown[]) => {
      txStatements.push(statementOfCall(args));
      return 0;
    }),
  };
  const transactionOptions: Array<Record<string, unknown> | undefined> = [];
  const prisma = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>, options?: Record<string, unknown>) => {
      transactionOptions.push(options);
      return work(tx);
    }),
  };
  return { repo: new AuthRepository(prisma as unknown as PrismaService), prisma, tx, txStatements, transactionOptions };
}

const lockGranted = { locked: true, isolation: 'read committed' };
const issuedRow = {
  cooldown_retry_sec: null,
  hourly_retry_sec: null,
  daily_retry_sec: null,
  global_retry_sec: null,
  global_count: 41,
  inserted_id: 7,
};

describe('AuthRepository.issueOtp: the issuing transaction (ADR-035 3.3 and 3.4)', () => {
  it('opens a short READ COMMITTED transaction with maxWait 2 s and timeout 5 s', async () => {
    const { repo, transactionOptions } = transactionHarness([[lockGranted], [issuedRow]]);

    await repo.issueOtp({ phone: PHONE, codeHash: HASH, policy });

    expect(transactionOptions).toEqual([
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 2_000, timeout: 5_000 },
    ]);
  });

  it('takes the advisory lock with the transaction client, never with the pool client, as the first statement', async () => {
    const { repo, prisma, txStatements } = transactionHarness([[lockGranted], [issuedRow]]);

    await repo.issueOtp({ phone: PHONE, codeHash: HASH, policy });

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    const first = txStatements[0] as Statement;
    expect(first.text).toContain('pg_try_advisory_xact_lock');
    expect(first.text).toContain("current_setting('transaction_isolation')");
    expect(first.text).not.toMatch(/\bpg_advisory_xact_lock\b/);
    expect(first.values).toEqual([91_101, PHONE]);
  });

  it('runs the verdict and the write as one single statement after the lock (two statements in total)', async () => {
    const { repo, txStatements } = transactionHarness([[lockGranted], [issuedRow]]);

    await repo.issueOtp({ phone: PHONE, codeHash: HASH, policy });

    expect(txStatements).toHaveLength(2);
    const write = (txStatements[1] as Statement).text;
    expect(write).toContain('expired AS (');
    expect(write).toContain('INSERT INTO auth.otp_code');
    expect(write).toContain("timezone('utc', clock_timestamp())");
    expect(write).toContain('OFFSET');
  });

  it('binds the phone, the hash and every policy number as parameters, never inside the statement text', async () => {
    const { repo, txStatements } = transactionHarness([[lockGranted], [issuedRow]]);

    await repo.issueOtp({ phone: PHONE, codeHash: HASH, policy });

    const write = txStatements[1] as Statement;
    expect(write.text).not.toContain(PHONE);
    expect(write.text).not.toContain(HASH);
    expect(write.values).toEqual(expect.arrayContaining([PHONE, HASH, 300, 30, 3_600, 4, 86_400, 9, 299]));
    expect(write.text).toMatch(/\$\d+::int/);
  });

  it('aborts without writing when the isolation level is not READ COMMITTED (fails closed)', async () => {
    const { repo, txStatements } = transactionHarness([[{ locked: true, isolation: 'repeatable read' }]]);

    await expect(repo.issueOtp({ phone: PHONE, codeHash: HASH, policy })).rejects.toThrow(/read committed/i);

    expect(txStatements).toHaveLength(1);
  });

  it('aborts without writing when the isolation level is serializable', async () => {
    const { repo, txStatements } = transactionHarness([[{ locked: true, isolation: 'serializable' }]]);

    await expect(repo.issueOtp({ phone: PHONE, codeHash: HASH, policy })).rejects.toThrow();

    expect(txStatements).toHaveLength(1);
  });

  it('answers busy and writes nothing when the advisory lock is not granted', async () => {
    const { repo, txStatements } = transactionHarness([[{ locked: false, isolation: 'read committed' }]]);

    await expect(repo.issueOtp({ phone: PHONE, codeHash: HASH, policy })).resolves.toEqual({ kind: 'busy' });

    expect(txStatements).toHaveLength(1);
  });

  it('answers issued with the inserted id and the global count before the insertion', async () => {
    const { repo } = transactionHarness([[lockGranted], [issuedRow]]);

    await expect(repo.issueOtp({ phone: PHONE, codeHash: HASH, policy })).resolves.toEqual({
      kind: 'issued',
      insertedId: 7,
      globalCount: 41,
    });
  });

  it('answers refused with every wait when nothing was inserted', async () => {
    const { repo } = transactionHarness([
      [lockGranted],
      [
        {
          cooldown_retry_sec: 12,
          hourly_retry_sec: 600,
          daily_retry_sec: null,
          global_retry_sec: null,
          global_count: 3,
          inserted_id: null,
        },
      ],
    ]);

    await expect(repo.issueOtp({ phone: PHONE, codeHash: HASH, policy })).resolves.toEqual({
      kind: 'refused',
      verdict: { waits: { cooldown: 12, hourly: 600, daily: null, global: null }, globalCount: 3 },
    });
  });
});

describe('AuthRepository.evaluateOtpIssuance: the read-only pre-check', () => {
  it('runs the shared verdict without any write, hash or lock, through the pool client', async () => {
    const { repo, prisma } = transactionHarness([]);
    prisma.$queryRaw.mockResolvedValue([
      {
        cooldown_retry_sec: null,
        hourly_retry_sec: 600,
        daily_retry_sec: null,
        global_retry_sec: null,
        global_count: 12,
        inserted_id: null,
      },
    ]);

    const verdict = await repo.evaluateOtpIssuance(PHONE, policy);

    expect(verdict).toEqual({ waits: { cooldown: null, hourly: 600, daily: null, global: null }, globalCount: 12 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    const statement = statementOfCall(prisma.$queryRaw.mock.calls[0] ?? []);
    expect(statement.text).toContain('verdict AS (');
    expect(statement.text).not.toContain('INSERT');
    expect(statement.text).not.toContain('UPDATE');
    expect(statement.text).not.toContain('pg_try_advisory');
    expect(statement.text).not.toContain(PHONE);
    expect(statement.values).toContain(PHONE);
  });
});

describe('AuthRepository: reservation, refund and live lookup', () => {
  it('reserves with one conditional UPDATE that returns the hash, and nothing else', async () => {
    const { repo, prisma } = transactionHarness([]);
    prisma.$queryRaw.mockResolvedValue([{ code_hash: 'stored-hash' }]);

    await expect(repo.reserveOtpAttempt(9, 5)).resolves.toBe('stored-hash');

    const statement = statementOfCall(prisma.$queryRaw.mock.calls[0] ?? []);
    expect(statement.text).toContain('UPDATE auth.otp_code');
    expect(statement.text).toContain('SET attempts = attempts + 1');
    expect(statement.text).toContain('attempts < $');
    expect(statement.text).not.toContain('attempts <= ');
    expect(statement.text).toContain('consumed = false');
    expect(statement.text).toContain("expires_at > timezone('utc', now())");
    expect(statement.text).toContain('RETURNING code_hash');
    expect(statement.values).toEqual([9, 5]);
  });

  it('answers null when the reservation returns no row', async () => {
    const { repo, prisma } = transactionHarness([]);
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(repo.reserveOtpAttempt(9, 5)).resolves.toBeNull();
  });

  it('reads the state of an unreserved OTP from a separate statement with an explicit attempts comparison', async () => {
    const { repo, prisma } = transactionHarness([]);
    prisma.$queryRaw.mockResolvedValue([{ consumed: false, alive: true, exhausted: true }]);

    await expect(repo.readOtpReservationState(9, 5)).resolves.toEqual({
      consumed: false,
      alive: true,
      exhausted: true,
    });

    const statement = statementOfCall(prisma.$queryRaw.mock.calls[0] ?? []);
    expect(statement.text).toContain('attempts >= $');
    expect(statement.values).toEqual([5, 9]);
  });

  it('answers null when the OTP row does not exist', async () => {
    const { repo, prisma } = transactionHarness([]);
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(repo.readOtpReservationState(9, 5)).resolves.toBeNull();
  });

  it('finds the live OTP of a phone: not consumed, not expired, newest first', async () => {
    const { repo, prisma } = transactionHarness([]);
    prisma.$queryRaw.mockResolvedValue([{ id: 31 }]);

    await expect(repo.findLiveOtp(PHONE)).resolves.toBe(31);

    const statement = statementOfCall(prisma.$queryRaw.mock.calls[0] ?? []);
    expect(statement.text).toContain('consumed = false');
    expect(statement.text).toContain("expires_at > timezone('utc', now())");
    expect(statement.text).toContain('ORDER BY created_at DESC, id DESC');
    expect(statement.values).toEqual([PHONE]);
  });

  it('answers null when the phone has no live OTP', async () => {
    const { repo, prisma } = transactionHarness([]);
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(repo.findLiveOtp(PHONE)).resolves.toBeNull();
  });

  it('refunds only an untouched issuance: attempts = 0 and not consumed', async () => {
    const { repo, prisma } = transactionHarness([]);
    prisma.$executeRaw.mockResolvedValue(1);

    await expect(repo.refundOtpIssuance(7)).resolves.toBe(true);

    const statement = statementOfCall(prisma.$executeRaw.mock.calls[0] ?? []);
    expect(statement.text).toContain('DELETE FROM auth.otp_code');
    expect(statement.text).toContain('attempts = 0');
    expect(statement.text).toContain('consumed = false');
    expect(statement.values).toEqual([7]);
  });

  it('answers false when nothing was refunded', async () => {
    const { repo, prisma } = transactionHarness([]);
    prisma.$executeRaw.mockResolvedValue(0);

    await expect(repo.refundOtpIssuance(7)).resolves.toBe(false);
  });
});

describe('the repository SQL is built only with tagged templates (security condition 13.7)', () => {
  const source = readFileSync(join(__dirname, 'auth.repository.ts'), 'utf8');
  const fragments = readFileSync(join(__dirname, 'otp-issuance-sql.ts'), 'utf8');

  it.each([
    ['the repository', source],
    ['the shared fragments', fragments],
  ])('%s never uses an Unsafe raw query', (_name, text) => {
    expect(text).not.toMatch(/Unsafe/);
  });

  it('the shared fragments are composed with Prisma.sql, not with JavaScript string templates', () => {
    const untagged = [...fragments.matchAll(/(\S*)`\s*(?:WITH|SELECT)\s/g)].filter(
      (match) => !(match[1] ?? '').endsWith('Prisma.sql'),
    );

    expect(fragments).toContain('Prisma.sql');
    expect(untagged).toHaveLength(0);
  });
});
