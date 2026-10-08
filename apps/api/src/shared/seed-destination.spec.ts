import { assertSeedDestinationLooksDisposable, findRealDataSignals } from './seed-destination';

describe('findRealDataSignals', () => {
  it('empty database -> no signals', () => {
    expect(findRealDataSignals({ tripRequestCount: 0, companyCount: 0 })).toEqual([]);
  });

  it('a previously seeded database (one company, no trips) -> no signals', () => {
    expect(findRealDataSignals({ tripRequestCount: 0, companyCount: 1 })).toEqual([]);
  });

  it('any trip request -> a signal', () => {
    expect(findRealDataSignals({ tripRequestCount: 1, companyCount: 1 })).toHaveLength(1);
  });

  it('more than one company -> a signal', () => {
    expect(findRealDataSignals({ tripRequestCount: 0, companyCount: 2 })).toHaveLength(1);
  });

  it('both -> two signals', () => {
    expect(findRealDataSignals({ tripRequestCount: 40, companyCount: 3 })).toHaveLength(2);
  });
});

describe('assertSeedDestinationLooksDisposable', () => {
  it('throws when the destination holds trips', () => {
    expect(() => assertSeedDestinationLooksDisposable({ tripRequestCount: 5, companyCount: 1 })).toThrow(
      /datos reales/,
    );
  });

  it('does not throw on a disposable destination', () => {
    expect(() =>
      assertSeedDestinationLooksDisposable({ tripRequestCount: 0, companyCount: 1 }),
    ).not.toThrow();
  });
});
