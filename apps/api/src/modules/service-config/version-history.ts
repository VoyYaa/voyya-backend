import type { VersionPage } from './service-config.types';

export function authorName(user: { firstName: string; lastName: string }): string {
  return `${user.firstName} ${user.lastName}`.trim();
}

export function pageVersions<T>(
  rows: readonly T[],
  limit: number,
  idOf: (row: T) => number,
): VersionPage<T> {
  const versions = rows.slice(0, limit);
  const last = versions[versions.length - 1];
  const hasMore = rows.length > limit;
  return { versions, nextBefore: hasMore && last !== undefined ? idOf(last) : null };
}
