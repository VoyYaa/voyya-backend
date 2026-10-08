import { type CompanyCandidate, pickNearest } from './nearest-candidate';

const candidate = (companyId: number, distanceM: number, tripsLast3h = 0): CompanyCandidate => ({
  companyId,
  driverId: companyId * 10,
  vehicleId: companyId * 10 + 1,
  distanceM,
  tripsLast3h,
});

describe('pickNearest', () => {
  it('no candidates -> null', () => {
    expect(pickNearest([])).toBeNull();
  });

  it('the global minimum distance wins, whatever the company', () => {
    expect(pickNearest([candidate(1, 500), candidate(2, 120), candidate(3, 900)])?.companyId).toBe(2);
  });

  it('equal distance: the driver with fewer recent trips wins', () => {
    expect(pickNearest([candidate(1, 300, 3), candidate(2, 300, 1)])?.companyId).toBe(2);
  });

  it('a tie in both keys is decided by the random source, never by company id', () => {
    const tied = [candidate(1, 300), candidate(2, 300), candidate(3, 300)];

    expect(pickNearest(tied, () => 0)?.companyId).toBe(1);
    expect(pickNearest(tied, () => 0.5)?.companyId).toBe(2);
    expect(pickNearest(tied, () => 0.99)?.companyId).toBe(3);
  });

  it('with a real random source both tied companies win over many draws (no bias)', () => {
    const tied = [candidate(1, 300), candidate(2, 300)];
    const wins = new Set<number>();
    for (let i = 0; i < 200; i += 1) wins.add(pickNearest(tied)?.companyId ?? 0);

    expect(wins).toEqual(new Set([1, 2]));
  });
});
