import {
  Controller, Get, Post, Delete,
  Body, Param, Query,
  UseGuards, Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BybitService } from './bybit.service';
import { CredentialsService } from '../credentials/credentials.service';
import { PlaceOrderDto } from '../mexc/dto/place-order.dto';
import { Throttle } from '@nestjs/throttler';

@UseGuards(JwtAuthGuard)
@Controller('bybit')
export class BybitController {
  constructor(
    private bybit: BybitService,
    private credentials: CredentialsService,
  ) {}

  private withCreds<T>(userId: string, use: (credentials: any) => Promise<T>) {
    return this.credentials.withDecrypted(userId, 'bybit', use);
  }

  // ── Public (no keys needed) ─────────────────────────────────────────────

  @Get('ticker')
  ticker() {
    return this.bybit.getTicker();
  }

  @Get('orderbook')
  orderbook(@Query('limit') limit?: string) {
    return this.bybit.getOrderBook(limit ? parseInt(limit) : 20);
  }

  @Get('trades')
  trades(@Query('limit') limit?: string) {
    return this.bybit.getRecentTrades(limit ? parseInt(limit) : 20);
  }

  // ── Authenticated ───────────────────────────────────────────────────────

  @Get('validate')
  async validate(@Request() req: any) {
    return this.withCreds(req.user.id, async (creds) => ({ valid: await this.bybit.validateCredentials(creds) }));
  }

  @Get('balances')
  async balances(@Request() req: any) {
    return this.withCreds(req.user.id, (creds) => this.bybit.getBalances(creds));
  }

  @Get('orders/open')
  async openOrders(@Request() req: any) {
    return this.withCreds(req.user.id, (creds) => this.bybit.getOpenOrders(creds));
  }

  @Get('orders/history')
  async orderHistory(@Request() req: any) {
    return this.withCreds(req.user.id, (creds) => this.bybit.getOrderHistory(creds));
  }

  @Get('orders/:orderId')
  async orderStatus(@Request() req: any, @Param('orderId') orderId: string) {
    return this.withCreds(req.user.id, (creds) => this.bybit.getOrderStatus(creds, orderId));
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('orders')
  async placeOrder(@Request() req: any, @Body() dto: PlaceOrderDto) {
    return this.withCreds(req.user.id, (creds) => this.bybit.placeOrder(req.user.id, creds, dto.side, dto.type, dto.quantity, dto.price, dto.quoteOrderQty, dto.idempotencyKey));
  }

  @Delete('orders')
  cancelAll(@Request() req: any) {
    return this.withCreds(req.user.id, (creds) => this.bybit.cancelAll(req.user.id, creds));
  }

  @Delete('orders/:orderId')
  async cancelOrder(@Request() req: any, @Param('orderId') orderId: string) {
    return this.withCreds(req.user.id, (creds) => this.bybit.cancelOrder(req.user.id, creds, orderId));
  }
}
