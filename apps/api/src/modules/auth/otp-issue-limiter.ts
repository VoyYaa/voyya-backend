import {
  OTP_ISSUE_CONCURRENCY,
  OTP_ISSUE_QUEUE_MAX,
  OTP_ISSUE_QUEUE_TIMEOUT_MS,
} from './otp-policy';

export class OtpIssueSaturatedError extends Error {
  constructor() {
    super('OTP issuance is saturated');
    this.name = 'OtpIssueSaturatedError';
  }
}

interface Waiter {
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OtpIssueLimiter {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly concurrency: number = OTP_ISSUE_CONCURRENCY,
    private readonly queueMax: number = OTP_ISSUE_QUEUE_MAX,
    private readonly timeoutMs: number = OTP_ISSUE_QUEUE_TIMEOUT_MS,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.queueMax) {
      return Promise.reject(new OtpIssueSaturatedError());
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: resolve,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) this.queue.splice(index, 1);
          reject(new OtpIssueSaturatedError());
        }, this.timeoutMs),
      };
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.active -= 1;
      return;
    }
    clearTimeout(next.timer);
    next.grant();
  }
}
