import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  Query,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MexcService } from './mexc.service';
import { CredentialsService } from '../credentials/credentials.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { Throttle } from '@nestjs/throttler';

@UseGuards(JwtAuthGuard)
@Controller('mexc')
export class MexcController {
  constructor(
    private mexc: MexcService,
    private credentials: CredentialsService,
  ) {}

  private withCreds<T>(userId: string, use: (credentials: any) => Promise<T>) {
    return this.credentials.withDecrypted(userId, 'mexc', use);
  }

  // --- Public market data (no keys needed) ---

  @Get('ticker')
  ticker() {
    return this.mexc.getTicker();
  }

  @Get('orderbook')
  orderbook(@Query('limit') limit?: string) {
    return this.mexc.getOrderBook(limit ? parseInt(limit) : 20);
  }

  @Get('trades')
  trades(@Query('limit') limit?: string) {
    return this.mexc.getRecentTrades(limit ? parseInt(limit) : 20);
  }

  // --- Authenticated endpoints ---

  @Get('validate')
  async validate(@Request() req) {
    return this.withCreds(req.user.id, async (creds) => ({ valid: await this.mexc.validateCredentials(creds) }));
  }

  @Get('balances')
  async balances(@Request() req) {
    return this.withCreds(req.user.id, (creds) => this.mexc.getBalances(creds));
  }

  @Get('orders/open')
  async openOrders(@Request() req) {
    return this.withCreds(req.user.id, (creds) => this.mexc.getOpenOrders(creds));
  }

  @Get('orders/history')
  async orderHistory(@Request() req) {
    return this.withCreds(req.user.id, (creds) => this.mexc.getOrderHistory(creds));
  }

  @Get('orders/:orderId')
  async orderStatus(@Request() req, @Param('orderId') orderId: string) {
    return this.withCreds(req.user.id, (creds) => this.mexc.getOrderStatus(creds, orderId));
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('orders')
  async placeOrder(@Request() req, @Body() dto: PlaceOrderDto) {
    return this.withCreds(req.user.id, (creds) => this.mexc.placeOrder(
      req.user.id,
      creds,
      dto.side,
      dto.type,
      dto.quantity,
      dto.price,
      dto.quoteOrderQty,
      dto.idempotencyKey,
    ));
  }

  @Delete('orders')
  cancelAll(@Request() req) {
    return this.withCreds(req.user.id, (creds) => this.mexc.cancelAll(req.user.id, creds));
  }

  @Delete('orders/:orderId')
  async cancelOrder(@Request() req, @Param('orderId') orderId: string) {
    return this.withCreds(req.user.id, (creds) => this.mexc.cancelOrder(req.user.id, creds, orderId));
  }
}
