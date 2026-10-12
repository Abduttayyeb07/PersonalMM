import { ConfigService } from '@nestjs/config';
import { EncryptionService } from './encryption.service';

const KEY = 'a'.repeat(64);
const AAD = 'user-a:mexc';

function service(current = KEY, previous = '') {
  const values: Record<string, string> = { ENCRYPTION_KEY: current, ENCRYPTION_KEY_PREV: previous };
  return new EncryptionService({ get: (name: string) => values[name] } as ConfigService);
}

describe('EncryptionService', () => {
  it('requires a 64-character hexadecimal current key', () => {
    expect(() => service('short')).toThrow(/64 hex/i);
    expect(() => service('z'.repeat(64))).toThrow(/64 hex/i);
  });

  it('prefixes ciphertext with its key version and round-trips with AAD', () => {
    const encrypted = service().encrypt('secret', AAD);
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(service().decrypt(encrypted, AAD)).toBe('secret');
  });

  it('cannot decrypt user A ciphertext under user B AAD', () => {
    const encrypted = service().encrypt('secret', 'user-a:mexc');
    expect(() => service().decrypt(encrypted, 'user-b:mexc')).toThrow();
  });

  it('decrypts with the previous key during rotation', () => {
    const oldKey = 'b'.repeat(64);
    const encrypted = service(oldKey).encrypt('secret', AAD);
    expect(service(KEY, oldKey).decrypt(encrypted, AAD)).toBe('secret');
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = service().encrypt('secret', AAD);
    const [version, payload] = encrypted.split(':');
    const bytes = Buffer.from(payload, 'base64');
    bytes[bytes.length - 1] ^= 1;
    expect(() => service().decrypt(`${version}:${bytes.toString('base64')}`, AAD)).toThrow();
  });
});
