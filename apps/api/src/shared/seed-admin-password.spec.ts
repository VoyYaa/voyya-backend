import { DEV_ADMIN_PASSWORD_PLACEHOLDER, resolveSeedAdminPassword } from './seed-admin-password';

describe('resolveSeedAdminPassword', () => {
  it('production without SEED_ADMIN_PASSWORD -> throws instead of seeding a known credential', () => {
    expect(() => resolveSeedAdminPassword({ NODE_ENV: 'production' })).toThrow(
      /SEED_ADMIN_PASSWORD/,
    );
  });

  it('production with an empty SEED_ADMIN_PASSWORD -> throws', () => {
    expect(() =>
      resolveSeedAdminPassword({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: '' }),
    ).toThrow(/SEED_ADMIN_PASSWORD/);
  });

  it('production with SEED_ADMIN_PASSWORD set -> returns it', () => {
    const result = resolveSeedAdminPassword({
      NODE_ENV: 'production',
      SEED_ADMIN_PASSWORD: 'a-strong-secret-1',
    });
    expect(result).toBe('a-strong-secret-1');
  });

  it('development without SEED_ADMIN_PASSWORD -> returns an obviously-fake placeholder', () => {
    const result = resolveSeedAdminPassword({ NODE_ENV: 'development' });
    expect(result).toBe(DEV_ADMIN_PASSWORD_PLACEHOLDER);
  });

  it('development with SEED_ADMIN_PASSWORD set -> honours the override', () => {
    const result = resolveSeedAdminPassword({
      NODE_ENV: 'development',
      SEED_ADMIN_PASSWORD: 'local-dev-secret',
    });
    expect(result).toBe('local-dev-secret');
  });
});
