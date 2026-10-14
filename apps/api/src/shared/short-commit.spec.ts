import { toShortCommit } from './short-commit';

const FULL_SHA = '65c2d01e3f5b7a9c1d2e4f60718293a4b5c6d7e8';

describe('toShortCommit (ADR-034 section 11, C-9, T-16)', () => {
  it('cuts a full SHA to its first 7 characters', () => {
    expect(toShortCommit(FULL_SHA)).toBe('65c2d01');
  });

  it('keeps a SHA that is already 7 characters', () => {
    expect(toShortCommit('65c2d01')).toBe('65c2d01');
  });

  it('accepts the boundaries of 7 and 40 hexadecimal characters', () => {
    expect(toShortCommit('a'.repeat(7))).toBe('aaaaaaa');
    expect(toShortCommit('f'.repeat(40))).toBe('fffffff');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too short', '65c2d0'],
    ['too long', 'a'.repeat(41)],
    ['uppercase', '65C2D01'],
    ['not hexadecimal', '65c2d0g'],
    ['a branch name', 'feat/push-pasajero'],
    ['a commit message', 'fix: something'],
    ['with a trailing newline', '65c2d01\n'],
    ['with surrounding spaces', ' 65c2d01 '],
    ['an injection attempt', '65c2d01"}<script>'],
  ])('%s -> null', (_label, raw) => {
    expect(toShortCommit(raw)).toBeNull();
  });
});
