import { ExchangeName } from './types';
import { createHash, randomBytes } from 'crypto';

// Generates a stable, traceable client order ID
// Format: zigx_<exchange>_<timestamp>_<random4>
// e.g.   zigx_kucoin_1749123456789_a8f2
export function generateClientOid(exchange: ExchangeName, idempotencyKey?: string): string {
  if (idempotencyKey) {
    const digest = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 20);
    return `zigx_${exchange}_${digest}`;
  }
  const ts = Date.now();
  const rand = randomBytes(3).toString('hex');
  return `zigx_${exchange}_${ts}_${rand}`;
}
