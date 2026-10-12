import { PrecisionEngine } from './precision.engine';

describe('PrecisionEngine', () => {
  const precision = new PrecisionEngine();

  it('rounds quantity and price down without floating-point drift', () => {
    expect(precision.round('1.239', '0.01')).toBe('1.23');
    expect(precision.round('0.3', '0.1')).toBe('0.3');
    expect(precision.round('0.30000000000000004', '0.1')).toBe('0.3');
  });
});
