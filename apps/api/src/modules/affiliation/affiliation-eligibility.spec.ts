import { isAffiliationEligible } from './affiliation-eligibility';

describe('isAffiliationEligible (ADR-031 §3.3, §7.1)', () => {
  it.each([
    ['a municipality in the catalog', { daneCode: '05887', daneType: 'municipality', status: 'catalog' }, true],
    ['a municipality with active coverage', { daneCode: '05887', daneType: 'municipality', status: 'active' }, true],
    ['an island such as San Andrés', { daneCode: '88001', daneType: 'island', status: 'catalog' }, true],
    ['a non-municipalized area', { daneCode: '91263', daneType: 'non_municipalized_area', status: 'catalog' }, false],
    ['a retired code', { daneCode: '05887', daneType: 'municipality', status: 'retired' }, false],
    ['a row without DANE code', { daneCode: null, daneType: 'municipality', status: 'catalog' }, false],
    ['a row without DANE type', { daneCode: '05887', daneType: null, status: 'catalog' }, false],
  ])('%s -> %s', (_label, candidate, expected) => {
    expect(isAffiliationEligible(candidate)).toBe(expected);
  });
});
