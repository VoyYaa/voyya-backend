export const AFFILIATION_ELIGIBLE_DANE_TYPES = ['municipality', 'island'] as const;

export interface EligibilityCandidate {
  daneCode: string | null;
  daneType: string | null;
  status: string;
}

export function isAffiliationEligible(candidate: EligibilityCandidate): boolean {
  return (
    candidate.daneCode !== null &&
    candidate.status !== 'retired' &&
    candidate.daneType !== null &&
    (AFFILIATION_ELIGIBLE_DANE_TYPES as readonly string[]).includes(candidate.daneType)
  );
}
