import { HttpException } from '@nestjs/common';
import { redact } from './redact';
import { RedactingLogger } from './redacting.logger';
import { AllExceptionsFilter } from './all-exceptions.filter';

const CANARY = 'CANARY_SECRET_123';

describe('redaction', () => {
  it.each([
    `apiKey=${CANARY}`,
    `{"apiSecret":"${CANARY}"}`,
    `X-MEXC-APIKEY: ${CANARY}`,
    `X-BAPI-SIGN: ${CANARY}`,
    `Authorization: ${CANARY}`,
    `listenKey=${CANARY}`,
    `signature=${CANARY}`,
  ])('removes %s', (line) => {
    expect(redact(line)).not.toContain(CANARY);
  });

  it('removes a 64-hex HMAC signature', () => {
    expect(redact(`failed ${'ab'.repeat(32)}`)).not.toMatch(/[a-f0-9]{64}/);
  });

  it('keeps the canary out of every logger level', () => {
    const lines: string[] = [];
    const out = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { lines.push(String(chunk)); return true; });
    const err = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => { lines.push(String(chunk)); return true; });
    const logger = new RedactingLogger();
    logger.log(`apiKey=${CANARY}`);
    logger.warn({ apiSecret: CANARY });
    logger.error(new Error(`signature=${CANARY}`));
    out.mockRestore();
    err.mockRestore();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).not.toContain(CANARY);
  });

  it('keeps the canary out of the HTTP response and the alert payload', async () => {
    const alert: any = { send: jest.fn() };
    const filter = new AllExceptionsFilter(alert);
    const json = jest.fn();
    const res: any = { status: jest.fn(() => ({ json })) };
    const req = { method: 'POST', path: '/api/credentials', url: '/api/credentials' };
    const host: any = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) };
    await filter.catch(new HttpException(`upstream rejected apiKey=${CANARY}`, 502), host);
    await filter.catch(new Error(`boom apiSecret=${CANARY}`), host);
    expect(JSON.stringify(json.mock.calls)).not.toContain(CANARY);
    expect(JSON.stringify(alert.send.mock.calls)).not.toContain(CANARY);
  });
});
