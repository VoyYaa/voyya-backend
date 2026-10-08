import { authorName, pageVersions } from './version-history';

describe('pageVersions', () => {
  const ids = (n: number): Array<{ id: number }> => Array.from({ length: n }, (_v, i) => ({ id: 100 - i }));

  it('returns everything and no cursor when the rows fit in the limit', () => {
    const page = pageVersions(ids(3), 5, (row) => row.id);

    expect(page.versions).toHaveLength(3);
    expect(page.nextBefore).toBeNull();
  });

  it('with one extra row it drops it and points the cursor to the last returned id', () => {
    const page = pageVersions(ids(6), 5, (row) => row.id);

    expect(page.versions.map((v) => v.id)).toEqual([100, 99, 98, 97, 96]);
    expect(page.nextBefore).toBe(96);
  });

  it('an empty history has no cursor', () => {
    expect(pageVersions([], 5, (row: { id: number }) => row.id)).toEqual({ versions: [], nextBefore: null });
  });
});

describe('authorName', () => {
  it('joins the first and last name and trims', () => {
    expect(authorName({ firstName: 'Ana', lastName: 'Pérez' })).toBe('Ana Pérez');
    expect(authorName({ firstName: 'Ana', lastName: '' })).toBe('Ana');
  });
});
