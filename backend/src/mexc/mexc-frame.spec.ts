import * as protobuf from 'protobufjs';
import { join } from 'path';
import { decodeMexcFrame } from './mexc-frame';

describe('MEXC protobuf frames', () => {
  let wrapper: protobuf.Type;
  beforeAll(async () => {
    const root = await protobuf.load(join(__dirname, 'proto', 'PushDataV3ApiWrapper.proto'));
    wrapper = root.lookupType('PushDataV3ApiWrapper');
  });

  it.each([
    ['depth', { channel: 'spot@public.aggre.depth.v3.api.pb@100ms@ZIGUSDT', publicAggreDepths: { bids: [{ price: '1', quantity: '2' }] } }, 'publicAggreDepths'],
    ['deals', { channel: 'spot@public.aggre.deals.v3.api.pb@100ms@ZIGUSDT', publicAggreDeals: { deals: [{ price: '1', quantity: '2', tradeType: 1, time: 1 }] } }, 'publicAggreDeals'],
    ['private orders', { channel: 'spot@private.orders.v3.api.pb', privateOrders: { id: '1', clientId: 'c1', status: 1 } }, 'privateOrders'],
  ])('decodes typed %s data', (_name, value, field) => {
    const raw = Buffer.from(wrapper.encode(wrapper.create(value)).finish());
    const decoded = decodeMexcFrame(wrapper, raw);
    expect(decoded.kind).toBe('protobuf');
    expect((decoded.value as any)[field]).toBeDefined();
  });

  it('routes JSON control frames without invoking protobuf decode', () => {
    const spy = jest.spyOn(wrapper, 'decode');
    const decoded = decodeMexcFrame(wrapper, Buffer.from('{"id":0,"code":0,"msg":"ok"}'));
    expect(decoded.kind).toBe('control');
    expect(spy).not.toHaveBeenCalled();
  });
});
