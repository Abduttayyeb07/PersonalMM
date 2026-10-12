import { validateEnvironment } from './validate-env';

const valid = {
  ENCRYPTION_KEY: 'a'.repeat(64),
  JWT_SECRET: 'a-secure-random-secret-with-more-than-32-characters',
  DATABASE_URL: 'postgresql://ziguser:strong-password@postgres:5432/zigdb',
  NODE_ENV: 'development',
};

describe('validateEnvironment', () => {
  it('rejects missing or short encryption keys', () => {
    expect(() => validateEnvironment({ ...valid, ENCRYPTION_KEY: '' })).toThrow(/ENCRYPTION_KEY/);
    expect(() => validateEnvironment({ ...valid, ENCRYPTION_KEY: 'abc' })).toThrow(/ENCRYPTION_KEY/);
  });
  it('rejects placeholder JWT secrets', () => {
    expect(() => validateEnvironment({ ...valid, JWT_SECRET: 'your-long-random-jwt-secret' })).toThrow(/JWT_SECRET/);
  });
  it('requires secure cookies and rejects zigpass in production', () => {
    expect(() => validateEnvironment({ ...valid, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(() => validateEnvironment({ ...valid, NODE_ENV: 'production', COOKIE_SECURE: 'true', DATABASE_URL: 'postgresql://u:zigpass@db/x' })).toThrow(/password/);
  });
});
