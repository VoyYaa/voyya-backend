import type { DbCandidate } from './candidate.repository';

export interface CompanyCandidate extends DbCandidate {
  companyId: number;
}

export function pickNearest(
  candidates: readonly CompanyCandidate[],
  random: () => number = Math.random,
): CompanyCandidate | null {
  if (candidates.length === 0) return null;
  const shortest = Math.min(...candidates.map((candidate) => candidate.distanceM));
  const closest = candidates.filter((candidate) => candidate.distanceM === shortest);
  const fewestTrips = Math.min(...closest.map((candidate) => candidate.tripsLast3h));
  const tied = closest.filter((candidate) => candidate.tripsLast3h === fewestTrips);
  return tied[Math.floor(random() * tied.length)] ?? null;
}
