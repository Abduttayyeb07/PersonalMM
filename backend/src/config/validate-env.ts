const PLACEHOLDER_SECRETS = new Set([
  'your-long-random-jwt-secret',
  'change-me',
  'changeme',
]);

export function validateEnvironment(config: Record<string, unknown>) {
  const encryptionKey = String(config.ENCRYPTION_KEY ?? '');
  const previousKey = String(config.ENCRYPTION_KEY_PREV ?? '');
  const jwtSecret = String(config.JWT_SECRET ?? '');
  const databaseUrl = String(config.DATABASE_URL ?? '');

  if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey)) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hexadecimal characters');
  }
  if (previousKey && !/^[a-fA-F0-9]{64}$/.test(previousKey)) {
    throw new Error('ENCRYPTION_KEY_PREV must be exactly 64 hexadecimal characters');
  }
  if (jwtSecret.length < 32 || PLACEHOLDER_SECRETS.has(jwtSecret.toLowerCase())) {
    throw new Error('JWT_SECRET must be at least 32 characters and not a placeholder');
  }
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (config.NODE_ENV === 'production') {
    if (/postgres(?:ql)?:\/\/[^:]+:zigpass@/i.test(databaseUrl)) {
      throw new Error('The default PostgreSQL password is forbidden in production');
    }
  }
  return config;
}
