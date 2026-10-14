const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

export const SHORT_COMMIT_LENGTH = 7;

export function toShortCommit(raw: string | undefined): string | null {
  if (raw === undefined || !COMMIT_SHA.test(raw)) return null;
  return raw.slice(0, SHORT_COMMIT_LENGTH);
}
