import {
  DEV_DRIVER_PIN,
  assertSeedTargetIsLocal,
  isProvablyLocalSeedTarget,
  resolveSeedDriverPin,
} from './seed-target';

const LOCAL_URL = 'postgresql://voyya_owner:pw@localhost:5459/voyya';
const REMOTE_URL = 'postgresql://u:p@monorail.proxy.rlwy.net:12345/railway';

describe('isProvablyLocalSeedTarget', () => {
  it.each([
    ['localhost', 'postgresql://u:p@localhost:5459/voyya'],
    ['127.0.0.1', 'postgresql://u:p@127.0.0.1:5432/voyya'],
    ['ipv6 loopback', 'postgresql://u:p@[::1]:5432/voyya'],
  ])('%s with NODE_ENV unset -> local', (_label, url) => {
    expect(isProvablyLocalSeedTarget({ DATABASE_URL: url })).toBe(true);
  });

  it.each(['development', 'test'])('NODE_ENV=%s with a local database -> local', (nodeEnv) => {
    expect(isProvablyLocalSeedTarget({ NODE_ENV: nodeEnv, DATABASE_URL: LOCAL_URL })).toBe(true);
  });

  it('NODE_ENV=production -> not local even with a local host', () => {
    expect(isProvablyLocalSeedTarget({ NODE_ENV: 'production', DATABASE_URL: LOCAL_URL })).toBe(
      false,
    );
  });

  it('a remote host with NODE_ENV=development -> not local', () => {
    expect(isProvablyLocalSeedTarget({ NODE_ENV: 'development', DATABASE_URL: REMOTE_URL })).toBe(
      false,
    );
  });

  it('a remote host with NODE_ENV unset -> not local', () => {
    expect(isProvablyLocalSeedTarget({ DATABASE_URL: REMOTE_URL })).toBe(false);
  });

  it('a hostname that merely starts with localhost -> not local', () => {
    expect(
      isProvablyLocalSeedTarget({ DATABASE_URL: 'postgresql://u:p@localhost.evil.com:5432/v' }),
    ).toBe(false);
  });

  it('a host override in the query string -> not local', () => {
    expect(
      isProvablyLocalSeedTarget({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/voyya?host=db.example.com',
      }),
    ).toBe(false);
  });

  it('no DATABASE_URL -> not local', () => {
    expect(isProvablyLocalSeedTarget({ NODE_ENV: 'development' })).toBe(false);
  });

  it('an unparseable DATABASE_URL -> not local', () => {
    expect(isProvablyLocalSeedTarget({ DATABASE_URL: 'not a url' })).toBe(false);
  });
});

describe('assertSeedTargetIsLocal', () => {
  it('remote host with every SEED_* secret set -> still throws', () => {
    expect(() =>
      assertSeedTargetIsLocal({
        NODE_ENV: 'production',
        DATABASE_URL: REMOTE_URL,
        SEED_ADMIN_PASSWORD: 'a-strong-secret-1',
        SEED_DRIVER_PIN: '830241',
      }),
    ).toThrow(/base local/);
  });

  it('local host -> does not throw', () => {
    expect(() => assertSeedTargetIsLocal({ DATABASE_URL: LOCAL_URL })).not.toThrow();
  });
});

describe('resolveSeedDriverPin', () => {
  it('local target -> the development PIN', () => {
    expect(resolveSeedDriverPin({ NODE_ENV: 'development', DATABASE_URL: LOCAL_URL })).toBe(
      DEV_DRIVER_PIN,
    );
  });

  it('local target with NODE_ENV unset -> the development PIN (bootstrap-db.sh flow)', () => {
    expect(resolveSeedDriverPin({ DATABASE_URL: LOCAL_URL })).toBe(DEV_DRIVER_PIN);
  });

  it('production with a local host -> throws', () => {
    expect(() =>
      resolveSeedDriverPin({ NODE_ENV: 'production', DATABASE_URL: LOCAL_URL }),
    ).toThrow(/base local/);
  });

  it('NODE_ENV missing on a remote database -> throws', () => {
    expect(() => resolveSeedDriverPin({ DATABASE_URL: REMOTE_URL })).toThrow(/base local/);
  });

  it('no DATABASE_URL -> throws', () => {
    expect(() => resolveSeedDriverPin({})).toThrow(/base local/);
  });

  it('SEED_DRIVER_PIN no longer unlocks a remote database', () => {
    expect(() =>
      resolveSeedDriverPin({ DATABASE_URL: REMOTE_URL, SEED_DRIVER_PIN: '830241' }),
    ).toThrow(/base local/);
  });
});
