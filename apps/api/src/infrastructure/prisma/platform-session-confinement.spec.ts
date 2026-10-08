import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SOURCE_ROOT = join(__dirname, '..', '..');
const ALLOWED_FILE = join('infrastructure', 'prisma', 'prisma.service.ts');
const PLATFORM_SESSION = 'app.platform_session';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('app.platform_session confinement (MD-11)', () => {
  it('appears only in PrismaService.runAsPlatform', () => {
    const offenders = sourceFiles(SOURCE_ROOT)
      .filter((file) => readFileSync(file, 'utf8').includes(PLATFORM_SESSION))
      .map((file) => relative(SOURCE_ROOT, file))
      .filter((file) => file !== ALLOWED_FILE);

    expect(offenders).toEqual([]);
  });

  it('is always set with is_local = true', () => {
    const source = readFileSync(join(SOURCE_ROOT, ALLOWED_FILE), 'utf8');
    const calls = source.match(/set_config\('app\.platform_session'[^)]*\)/g) ?? [];

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/, true\)$/);
  });
});
