import { Logger } from '@nestjs/common';
import type { EnvService } from '../../../config/env.service';
import {
  PASSENGER_PUSH_LEDGER_MAX_AGE_MS,
  PASSENGER_PUSH_LEDGER_MAX_ENTRIES,
  PassengerPushLedger,
} from './passenger-push.ledger';

function ledger(maxPerTrip = 10): PassengerPushLedger {
  const env = {
    get: (key: string) => (key === 'PASSENGER_PUSH_MAX_PER_TRIP' ? maxPerTrip : undefined),
  } as unknown as EnvService;
  return new PassengerPushLedger(env);
}

const noop = async (): Promise<void> => undefined;

describe('PassengerPushLedger · "new driver" fact (ADR-034 section 3.2)', () => {
  it('a trip without a recorded driver cancellation is not a reassignment', () => {
    expect(ledger().hadDriverCancellation(17)).toBe(false);
  });

  it('after a recorded driver cancellation, that trip (and only that trip) is a reassignment', () => {
    const l = ledger();

    l.recordDriverCancellation(17);

    expect(l.hadDriverCancellation(17)).toBe(true);
    expect(l.hadDriverCancellation(18)).toBe(false);
  });

  it('forgetting a trip clears the fact', () => {
    const l = ledger();
    l.recordDriverCancellation(17);

    l.forget(17);

    expect(l.hadDriverCancellation(17)).toBe(false);
  });
});

describe('PassengerPushLedger · cap per trip (ADR-034 section 3.3, T-6)', () => {
  it('admits as many sends as the configured cap and refuses the next one', () => {
    const l = ledger(3);

    const admitted = [1, 2, 3].map(() => l.submit(17, noop));
    const refused = l.submit(17, noop);

    expect(admitted.every((delivery) => delivery !== null)).toBe(true);
    expect(refused).toBeNull();
  });

  it('the default of ten: the eleventh notice of a trip is refused, the tenth is not', () => {
    const l = ledger(10);

    const results = Array.from({ length: 11 }, () => l.submit(17, noop));

    expect(results.slice(0, 10).every((delivery) => delivery !== null)).toBe(true);
    expect(results[10]).toBeNull();
  });

  it('the cap is per trip: another trip is untouched', () => {
    const l = ledger(1);
    l.submit(17, noop);

    expect(l.submit(17, noop)).toBeNull();
    expect(l.submit(18, noop)).not.toBeNull();
  });

  it('a refused submit never runs the notice', async () => {
    const l = ledger(1);
    const run = jest.fn(noop);
    await l.submit(17, noop);

    l.submit(17, run);

    expect(run).not.toHaveBeenCalled();
  });

  it('forgetting a trip resets its counter', () => {
    const l = ledger(1);
    l.submit(17, noop);
    l.forget(17);

    expect(l.submit(17, noop)).not.toBeNull();
  });
});

describe('PassengerPushLedger · one send at a time per trip (ADR-034 section 3.3)', () => {
  it('runs the sends of a trip in the order of the facts, even when the first is slower', async () => {
    const l = ledger();
    const order: string[] = [];
    const slow = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('first');
    };
    const fast = async (): Promise<void> => {
      order.push('second');
    };

    const first = l.submit(17, slow);
    const second = l.submit(17, fast);
    await Promise.all([first, second]);

    expect(order).toEqual(['first', 'second']);
  });

  it('a send that fails does not block the next one of the same trip', async () => {
    const l = ledger();
    const ran: string[] = [];

    const failing = l.submit(17, async () => {
      throw new Error('boom');
    });
    const next = l.submit(17, async () => {
      ran.push('next');
    });

    await expect(failing).rejects.toThrow('boom');
    await next;
    expect(ran).toEqual(['next']);
  });

  it('two different trips do not wait for each other', async () => {
    const l = ledger();
    let releaseFirst: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const ran: string[] = [];

    const first = l.submit(17, () => blocked.then(() => void ran.push('trip 17')));
    await l.submit(18, async () => void ran.push('trip 18'));
    releaseFirst();
    await first;

    expect(ran).toEqual(['trip 18', 'trip 17']);
  });

  it('forgetting a trip while a send is in flight does not cancel that send', async () => {
    const l = ledger();
    const run = jest.fn(noop);

    const delivery = l.submit(17, run);
    l.forget(17);
    await delivery;

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('PassengerPushLedger · bounded memory and eviction policy (C-11, S-12, T-6)', () => {
  let warnings: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    jest.setSystemTime(new Date('2026-10-13T12:00:00.000Z'));
    warnings = [];
    spy = jest.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(String(args[0]));
    });
  });

  afterEach(() => {
    spy.mockRestore();
    jest.useRealTimers();
  });

  function fill(l: PassengerPushLedger, count: number): void {
    for (let id = 1; id <= count; id += 1) l.recordDriverCancellation(id);
  }

  it('keeps at most 5000 entries: the 5001st evicts the oldest one and logs it without personal data', () => {
    const l = ledger();
    fill(l, PASSENGER_PUSH_LEDGER_MAX_ENTRIES);

    l.recordDriverCancellation(99_999);

    expect(l.hadDriverCancellation(1)).toBe(false);
    expect(l.hadDriverCancellation(2)).toBe(true);
    expect(l.hadDriverCancellation(99_999)).toBe(true);
    expect(warnings).toEqual(['[push:passenger] evicted tripRequest=1']);
  });

  it('evicting never blocks nor drops the new send and never throws', async () => {
    const l = ledger();
    fill(l, PASSENGER_PUSH_LEDGER_MAX_ENTRIES);
    const run = jest.fn(noop);

    const delivery = l.submit(99_999, run);

    expect(delivery).not.toBeNull();
    await delivery;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('the worst case of an eviction is a forgotten fact and a counter back at zero for the evicted trip', () => {
    const l = ledger(1);
    l.submit(1, noop);
    for (let id = 2; id <= PASSENGER_PUSH_LEDGER_MAX_ENTRIES + 1; id += 1) l.recordDriverCancellation(id);

    expect(l.submit(1, noop)).not.toBeNull();
  });

  it('an entry older than six hours is discarded when it is consulted', () => {
    const l = ledger();
    l.recordDriverCancellation(17);

    jest.setSystemTime(Date.now() + PASSENGER_PUSH_LEDGER_MAX_AGE_MS + 1);

    expect(l.hadDriverCancellation(17)).toBe(false);
  });

  it('an entry of exactly six hours is still alive', () => {
    const l = ledger();
    l.recordDriverCancellation(17);

    jest.setSystemTime(Date.now() + PASSENGER_PUSH_LEDGER_MAX_AGE_MS);

    expect(l.hadDriverCancellation(17)).toBe(true);
  });

  it('expired entries are swept on insert before anything fresh is evicted', () => {
    const l = ledger();
    fill(l, PASSENGER_PUSH_LEDGER_MAX_ENTRIES);
    jest.setSystemTime(Date.now() + PASSENGER_PUSH_LEDGER_MAX_AGE_MS + 1);

    l.recordDriverCancellation(99_999);

    expect(warnings).toEqual([]);
    expect(l.hadDriverCancellation(99_999)).toBe(true);
  });
});
