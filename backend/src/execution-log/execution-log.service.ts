import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface LogOrderParams {
  userId: string;
  exchange: string;
  symbol: string;
  side: string;
  type: string;
  quantity?: string;
  price?: string;
  quoteQty?: string;
  clientOrderId: string;
}

export interface LogOrderResult {
  logId: string;
  resolve: (exchangeOrderId: string, latencyMs: number) => Promise<void>;
  reject:  (error: string,           latencyMs: number) => Promise<void>;
}

@Injectable()
export class ExecutionLogService {
  constructor(private prisma: PrismaService) {}

  async startOrder(params: LogOrderParams): Promise<LogOrderResult> {
    const log = await this.prisma.executionLog.create({
      data: {
        userId:        params.userId,
        exchange:      params.exchange,
        symbol:        params.symbol,
        action:        'placeOrder',
        side:          params.side,
        type:          params.type,
        quantity:      params.quantity,
        price:         params.price,
        quoteQty:      params.quoteQty,
        clientOrderId: params.clientOrderId,
        status:        'PENDING',
      },
    });

    return {
      logId: log.id,
      resolve: (exchangeOrderId, latencyMs) =>
        this.prisma.executionLog.update({
          where: { id: log.id },
          data:  { status: 'SUCCESS', exchangeOrderId, latencyMs },
        }).then(() => undefined),
      reject: (errorMessage, latencyMs) =>
        this.prisma.executionLog.update({
          where: { id: log.id },
          data:  { status: 'FAILED', errorMessage, latencyMs },
        }).then(() => undefined),
    };
  }

  async logCancel(userId: string, exchange: string, symbol: string, orderId: string) {
    return this.prisma.executionLog.create({
      data: {
        userId,
        exchange,
        symbol,
        action:          'cancelOrder',
        clientOrderId:   orderId,
        status:          'SUCCESS',
      },
    });
  }

  async getRecent(userId: string, limit = 50) {
    return this.prisma.executionLog.findMany({
      where:   { userId },
      orderBy: { createdAt: 'desc' },
      take:    limit,
      select: {
        id: true, exchange: true, symbol: true, action: true,
        side: true, type: true, quantity: true, price: true,
        clientOrderId: true, exchangeOrderId: true,
        status: true, errorMessage: true, latencyMs: true, createdAt: true,
      },
    });
  }
}
