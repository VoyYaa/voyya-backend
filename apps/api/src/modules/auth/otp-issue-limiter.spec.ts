import { OtpIssueLimiter, OtpIssueSaturatedError } from './otp-issue-limiter';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('OtpIssueLimiter (ADR-035 3.5): one issuing transaction at a time, waiting in memory', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs the work and returns its result', async () => {
    const limiter = new OtpIssueLimiter();
    await expect(limiter.run(async () => 'issued')).resolves.toBe('issued');
  });

  it('never runs two works at once with a concurrency of one', async () => {
    const limiter = new OtpIssueLimiter(1, 5, 3_000);
    let running = 0;
    let peak = 0;
    const works = Array.from({ length: 5 }, () =>
      limiter.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      }),
    );
    await Promise.all(works);
    expect(peak).toBe(1);
  });

  it('runs the queued works in arrival order', async () => {
    const limiter = new OtpIssueLimiter(1, 5, 3_000);
    const gate = deferred();
    const order: number[] = [];
    const first = limiter.run(async () => {
      await gate.promise;
      order.push(0);
    });
    const rest = [1, 2, 3].map((n) => limiter.run(async () => void order.push(n)));
    gate.resolve();
    await Promise.all([first, ...rest]);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('allows the configured number of works at once', async () => {
    const limiter = new OtpIssueLimiter(2, 5, 3_000);
    const gate = deferred();
    let running = 0;
    let peak = 0;
    const works = Array.from({ length: 4 }, () =>
      limiter.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    );
    await flushMicrotasks();
    expect(peak).toBe(2);
    gate.resolve();
    await Promise.all(works);
  });

  it('rejects at once when the queue is full: 1 running + 5 waiting accepted, the seventh refused', async () => {
    const limiter = new OtpIssueLimiter(1, 5, 3_000);
    const gate = deferred();
    const accepted = Array.from({ length: 6 }, () => limiter.run(() => gate.promise));
    await flushMicrotasks();
    await expect(limiter.run(async () => 'late')).rejects.toBeInstanceOf(OtpIssueSaturatedError);
    gate.resolve();
    await Promise.all(accepted);
  });

  it('rejects a waiter whose turn does not come before the deadline, and keeps serving the rest', async () => {
    jest.useFakeTimers();
    const limiter = new OtpIssueLimiter(1, 5, 3_000);
    const gate = deferred();
    const running = limiter.run(() => gate.promise);
    const waiter = limiter.run(async () => 'never');
    const outcome = waiter.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(2_999);
    await flushMicrotasks();
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(2);
    expect(await outcome).toBeInstanceOf(OtpIssueSaturatedError);

    gate.resolve();
    await running;
    await expect(limiter.run(async () => 'after')).resolves.toBe('after');
  });

  it('does not count a timed-out waiter in the queue', async () => {
    jest.useFakeTimers();
    const limiter = new OtpIssueLimiter(1, 1, 3_000);
    const gate = deferred();
    const running = limiter.run(() => gate.promise);
    const waiter = limiter.run(async () => 'never').catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(3_001);
    expect(await waiter).toBeInstanceOf(OtpIssueSaturatedError);
    const replacement = limiter.run(async () => 'second wait').catch((error: unknown) => error);
    gate.resolve();
    await running;
    expect(await replacement).toBe('second wait');
  });

  it('returns the turn when the work throws, so the next work runs', async () => {
    const limiter = new OtpIssueLimiter(1, 5, 3_000);
    await expect(
      limiter.run(async () => {
        throw new Error('transaction failed');
      }),
    ).rejects.toThrow('transaction failed');
    await expect(limiter.run(async () => 'next')).resolves.toBe('next');
  });

  it('returns the turn when the work throws while another is waiting', async () => {
    const limiter = new OtpIssueLimiter(1, 5, 3_000);
    const gate = deferred();
    const failing = limiter.run(async () => {
      await gate.promise;
      throw new Error('boom');
    });
    const waiting = limiter.run(async () => 'served');
    gate.resolve();
    await expect(failing).rejects.toThrow('boom');
    await expect(waiting).resolves.toBe('served');
  });

  it('uses the ADR values by default', async () => {
    const limiter = new OtpIssueLimiter();
    const gate = deferred();
    const accepted = Array.from({ length: 6 }, () => limiter.run(() => gate.promise));
    await flushMicrotasks();
    await expect(limiter.run(async () => 'seventh')).rejects.toBeInstanceOf(OtpIssueSaturatedError);
    gate.resolve();
    await Promise.all(accepted);
  });
});
