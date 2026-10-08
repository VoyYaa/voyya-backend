export interface NeutralizationFacts {
  expectedCount: number;
  matchedCount: number;
  activeDriverCount: number;
}

export function findNeutralizationBlockers(facts: NeutralizationFacts): string[] {
  const blockers: string[] = [];
  if (facts.matchedCount !== facts.expectedCount) {
    blockers.push(`matched ${facts.matchedCount} of ${facts.expectedCount} requested drivers`);
  }
  if (facts.activeDriverCount > 0) {
    blockers.push(`${facts.activeDriverCount} driver(s) have an active trip or assignment`);
  }
  return blockers;
}
