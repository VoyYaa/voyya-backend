export interface SeedDestinationCounts {
  tripRequestCount: number;
  companyCount: number;
}

export function findRealDataSignals(counts: SeedDestinationCounts): string[] {
  const signals: string[] = [];
  if (counts.tripRequestCount > 0) signals.push('trips.trip_request has rows');
  if (counts.companyCount > 1) signals.push('tenancy.company has more than one company');
  return signals;
}

export function assertSeedDestinationLooksDisposable(counts: SeedDestinationCounts): void {
  const signals = findRealDataSignals(counts);
  if (signals.length === 0) return;
  throw new Error(
    `El seed se niega: el destino parece contener datos reales (${signals.join('; ')}). Si es una base local de pruebas, recréala con infra/scripts/bootstrap-db.sh`,
  );
}
