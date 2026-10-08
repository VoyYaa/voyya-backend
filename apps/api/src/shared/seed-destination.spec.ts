import { assertSeedDestinationIsEmpty, findNonEmptySignals } from './seed-destination';

describe('findNonEmptySignals', () => {
  it('freshly migrated database -> no signals', () => {
    expect(findNonEmptySignals({ userCount: 0, companyCount: 0 })).toEqual([]);
  });

  it('a database that was already seeded (the production shape) -> two signals', () => {
    expect(findNonEmptySignals({ userCount: 6, companyCount: 1 })).toHaveLength(2);
  });

  it('users without companies -> one signal', () => {
    expect(findNonEmptySignals({ userCount: 1, companyCount: 0 })).toHaveLength(1);
  });

  it('a company without users -> one signal', () => {
    expect(findNonEmptySignals({ userCount: 0, companyCount: 1 })).toHaveLength(1);
  });
});

describe('assertSeedDestinationIsEmpty', () => {
  it('throws on a seeded database and points to bootstrap-db.sh', () => {
    expect(() => assertSeedDestinationIsEmpty({ userCount: 6, companyCount: 1 })).toThrow(
      /bootstrap-db\.sh/,
    );
  });

  it('does not throw on an empty database', () => {
    expect(() => assertSeedDestinationIsEmpty({ userCount: 0, companyCount: 0 })).not.toThrow();
  });
});
