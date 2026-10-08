import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const API_ROOT = join(__dirname, '..', '..', '..');
const SOURCE_ROOT = join(API_ROOT, 'src');
const ALLOWED_FILE = join('infrastructure', 'prisma', 'prisma.service.ts');
const SEED_FILE = join(API_ROOT, 'prisma', 'seed.ts');
const PLATFORM_SESSION = 'app.platform_session';

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

function findPlatformSessionViolations(source: string): string[] {
  const violations: string[] = [];
  for (const call of source.match(/set_config\(\s*'app\.platform_session'[^)]*\)/g) ?? []) {
    if (!/,\s*true\s*\)$/.test(call)) violations.push(call);
  }
  for (const statement of source.match(/\bSET\s+(?:LOCAL\s+|SESSION\s+)?app\.platform_session[^;`'"]*/gi) ?? []) {
    violations.push(statement);
  }
  return violations;
}

describe('app.platform_session confinement (MD-11)', () => {
  it('appears only in PrismaService.runAsPlatform inside src', () => {
    const offenders = sourceFiles(SOURCE_ROOT)
      .filter((file) => readFileSync(file, 'utf8').includes(PLATFORM_SESSION))
      .map((file) => relative(SOURCE_ROOT, file))
      .filter((file) => file !== ALLOWED_FILE);

    expect(offenders).toEqual([]);
  });

  it('never appears in the operational scripts: they go through PrismaService.runAsPlatform', () => {
    const offenders = sourceFiles(join(API_ROOT, 'scripts'))
      .filter((file) => readFileSync(file, 'utf8').includes(PLATFORM_SESSION))
      .map((file) => relative(API_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('is always set with is_local = true in runAsPlatform', () => {
    const source = readFileSync(join(SOURCE_ROOT, ALLOWED_FILE), 'utf8');
    const calls = source.match(/set_config\('app\.platform_session'[^)]*\)/g) ?? [];

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/, true\)$/);
    expect(findPlatformSessionViolations(source)).toEqual([]);
  });

  it('is also local to the transaction in the seed, the only other place that writes configuration', () => {
    expect(findPlatformSessionViolations(readFileSync(SEED_FILE, 'utf8'))).toEqual([]);
  });

  describe('the rule itself', () => {
    it('flags a session-wide set_config', () => {
      const offender = "await tx.$executeRaw`SELECT set_config('app.platform_session', 'on', false)`;";
      expect(findPlatformSessionViolations(offender)).toHaveLength(1);
    });

    it('flags a SET and a SET LOCAL statement', () => {
      expect(findPlatformSessionViolations("await tx.$executeRawUnsafe(\"SET app.platform_session = 'on'\")")).toHaveLength(1);
      expect(findPlatformSessionViolations("SET LOCAL app.platform_session = 'on';")).toHaveLength(1);
    });

    it('accepts a transaction-local set_config', () => {
      const compliant = "SELECT set_config('app.platform_session', 'on', true)";
      expect(findPlatformSessionViolations(compliant)).toEqual([]);
    });
  });
});
