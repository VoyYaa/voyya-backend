import { findNeutralizationBlockers } from './neutralize-drivers-guard';

describe('findNeutralizationBlockers', () => {
  it('all matched and none active -> no blockers', () => {
    expect(
      findNeutralizationBlockers({ expectedCount: 3, matchedCount: 3, activeDriverCount: 0 }),
    ).toEqual([]);
  });

  it('partial match -> blocker', () => {
    const blockers = findNeutralizationBlockers({
      expectedCount: 3,
      matchedCount: 2,
      activeDriverCount: 0,
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/2 of 3/);
  });

  it('no match at all -> blocker', () => {
    expect(
      findNeutralizationBlockers({ expectedCount: 3, matchedCount: 0, activeDriverCount: 0 }),
    ).toHaveLength(1);
  });

  it('a driver mid-trip -> blocker', () => {
    const blockers = findNeutralizationBlockers({
      expectedCount: 3,
      matchedCount: 3,
      activeDriverCount: 1,
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/active trip/);
  });

  it('partial match and active trip -> both blockers', () => {
    expect(
      findNeutralizationBlockers({ expectedCount: 3, matchedCount: 1, activeDriverCount: 1 }),
    ).toHaveLength(2);
  });
});
