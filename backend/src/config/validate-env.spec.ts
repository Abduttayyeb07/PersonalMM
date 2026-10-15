import { validateEnvironment } from './validate-env';

const valid = {
  ENCRYPTION_KEY: 'a'.repeat(64),
  JWT_SECRET: 'a-secure-random-secret-with-more-than-32-characters',
  DATABASE_URL: 'postgresql://zig_grid:strong-password@postgres:5432/zig_grid_engine',
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
  it('rejects zigpass in production', () => {
    expect(() => validateEnvironment({ ...valid, NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:zigpass@db/x' })).toThrow(/password/);
  });
});
