import { DEV_ADMIN_PASSWORD_PLACEHOLDER, resolveSeedAdminPassword } from './seed-admin-password';

const LOCAL_URL = 'postgresql://voyya_owner:pw@localhost:5459/voyya';
const REMOTE_URL = 'postgresql://u:p@monorail.proxy.rlwy.net:12345/railway';

describe('resolveSeedAdminPassword', () => {
  it('production without SEED_ADMIN_PASSWORD -> throws', () => {
    expect(() => resolveSeedAdminPassword({ NODE_ENV: 'production' })).toThrow(/base local/);
  });

  it('production with SEED_ADMIN_PASSWORD set -> still throws', () => {
    expect(() =>
      resolveSeedAdminPassword({
        NODE_ENV: 'production',
        DATABASE_URL: LOCAL_URL,
        SEED_ADMIN_PASSWORD: 'a-strong-secret-1',
      }),
    ).toThrow(/base local/);
  });

  it('remote database with SEED_ADMIN_PASSWORD set and NODE_ENV unset -> still throws', () => {
    expect(() =>
      resolveSeedAdminPassword({ DATABASE_URL: REMOTE_URL, SEED_ADMIN_PASSWORD: 'a-strong-secret-1' }),
    ).toThrow(/base local/);
  });

  it('local without SEED_ADMIN_PASSWORD -> obviously-fake placeholder', () => {
    expect(resolveSeedAdminPassword({ NODE_ENV: 'development', DATABASE_URL: LOCAL_URL })).toBe(
      DEV_ADMIN_PASSWORD_PLACEHOLDER,
    );
  });

  it('local with an empty SEED_ADMIN_PASSWORD -> placeholder', () => {
    expect(resolveSeedAdminPassword({ DATABASE_URL: LOCAL_URL, SEED_ADMIN_PASSWORD: '' })).toBe(
      DEV_ADMIN_PASSWORD_PLACEHOLDER,
    );
  });

  it('local with SEED_ADMIN_PASSWORD set -> honours the override', () => {
    expect(
      resolveSeedAdminPassword({ DATABASE_URL: LOCAL_URL, SEED_ADMIN_PASSWORD: 'local-dev-secret' }),
    ).toBe('local-dev-secret');
  });
});
