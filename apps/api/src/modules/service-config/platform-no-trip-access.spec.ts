import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const MODULES_ROOT = join(__dirname, '..');
const FORBIDDEN = [
  /tripRequest/i,
  /trip_request/i,
  /TripsRepository/,
  /trips\.repository/,
  /modules\/trips/,
  /\.\.\/trips\//,
  /\.\.\/assignment\//,
  /assignment\.repository/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

function platformFiles(): string[] {
  const serviceConfig = sourceFiles(join(MODULES_ROOT, 'service-config'));
  const platformPrefixed = sourceFiles(MODULES_ROOT).filter((file) => /[\\/]platform-[^\\/]+\.ts$/.test(file));
  return [...new Set([...serviceConfig, ...platformPrefixed])];
}

describe('platform_admin has no way into trips (MD-14, HU-MS-09)', () => {
  it('covers the whole service-config module and every platform-* controller, service and repository', () => {
    const names = platformFiles().map((file) => relative(MODULES_ROOT, file).replace(/\\/g, '/'));

    expect(names).toEqual(
      expect.arrayContaining([
        'service-config/platform-fare.service.ts',
        'service-config/platform-commission.controller.ts',
        'affiliation/platform-company.service.ts',
        'affiliation/platform-company.repository.ts',
        'affiliation/platform-company.controller.ts',
      ]),
    );
  });

  it('none of them imports the trips repository, the assignment module or refers to tripRequest', () => {
    const offenders = platformFiles().flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return FORBIDDEN.filter((pattern) => pattern.test(source)).map(
        (pattern) => `${relative(MODULES_ROOT, file)} matches ${pattern}`,
      );
    });

    expect(offenders).toEqual([]);
  });
});
