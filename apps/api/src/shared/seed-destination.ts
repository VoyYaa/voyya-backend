export interface SeedDestinationCounts {
  userCount: number;
  companyCount: number;
}

export function findNonEmptySignals(counts: SeedDestinationCounts): string[] {
  const signals: string[] = [];
  if (counts.userCount > 0) signals.push('auth.user has rows');
  if (counts.companyCount > 0) signals.push('tenancy.company has rows');
  return signals;
}

export function assertSeedDestinationIsEmpty(counts: SeedDestinationCounts): void {
  const signals = findNonEmptySignals(counts);
  if (signals.length === 0) return;
  throw new Error(
    `El seed solo escribe en una base vacía y esta ya tiene datos (${signals.join('; ')}). Para volver a sembrar en local, borra el volumen de la base local (podman-compose down -v) y vuelve a correr infra/scripts/bootstrap-db.sh`,
  );
}
