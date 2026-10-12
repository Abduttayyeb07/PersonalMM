import { OrderStatus } from './types';

const MEXC_STATUS_MAP: Record<string, OrderStatus> = {
  NEW:              'NEW',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED:           'FILLED',
  CANCELED:         'CANCELED',
  PENDING_CANCEL:   'CANCELED',
  REJECTED:         'REJECTED',
};

const BYBIT_STATUS_MAP: Record<string, OrderStatus> = {
  New:                      'NEW',
  PartiallyFilled:          'PARTIALLY_FILLED',
  Filled:                   'FILLED',
  Cancelled:                'CANCELED',
  PartiallyFilledCanceled:  'CANCELED',
  Rejected:                 'REJECTED',
};

const KUCOIN_STATUS_MAP: Record<string, OrderStatus> = {
  open:      'NEW',
  active:    'NEW',
  done:      'FILLED',
  cancelled: 'CANCELED',
  cancel:    'CANCELED',
};

const GATEIO_STATUS_MAP: Record<string, OrderStatus> = {
  open:      'NEW',
  closed:    'FILLED',
  cancelled: 'CANCELED',
  cancel:    'CANCELED',
};

type Exchange = 'mexc' | 'bybit' | 'kucoin' | 'gateio';

const MAP: Record<Exchange, Record<string, OrderStatus>> = {
  mexc:   MEXC_STATUS_MAP,
  bybit:  BYBIT_STATUS_MAP,
  kucoin: KUCOIN_STATUS_MAP,
  gateio: GATEIO_STATUS_MAP,
};

export function normalizeOrderStatus(exchange: Exchange, raw: string): OrderStatus {
  return MAP[exchange]?.[raw] ?? 'NEW';
}
