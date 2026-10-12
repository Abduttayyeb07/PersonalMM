import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

@Injectable()
export class EncryptionService {
  private readonly key: Buffer;
  private readonly previousKey?: Buffer;

  constructor(private config: ConfigService) {
    const hexKey = this.config.get<string>('ENCRYPTION_KEY');
    if (!hexKey || !/^[a-fA-F0-9]{64}$/.test(hexKey)) {
      throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    }
    this.key = Buffer.from(hexKey, 'hex');
    const previous = this.config.get<string>('ENCRYPTION_KEY_PREV');
    if (previous && !/^[a-fA-F0-9]{64}$/.test(previous)) {
      throw new Error('ENCRYPTION_KEY_PREV must be 64 hex characters (32 bytes)');
    }
    this.previousKey = previous ? Buffer.from(previous, 'hex') : undefined;
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    // Format: iv(12) + authTag(16) + ciphertext — all base64
    return `v1:${Buffer.concat([iv, authTag, encrypted]).toString('base64')}`;
  }

  decrypt(ciphertext: string, aad: string): string {
    const versioned = ciphertext.startsWith('v1:');
    const payload = versioned ? ciphertext.slice(3) : ciphertext;
    const buf = Buffer.from(payload, 'base64');
    if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) throw new Error('Invalid ciphertext');
    const decryptWith = (key: Buffer) => {
    const iv = buf.subarray(0, IV_LENGTH);
    const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    if (versioned) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final('utf8');
    };
    try {
      return decryptWith(this.key);
    } catch (error) {
      if (!this.previousKey) throw error;
      return decryptWith(this.previousKey);
    }
  }
}
