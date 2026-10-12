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
import { GateioService } from './gateio.service';
import { CredentialsService } from '../credentials/credentials.service';
import { PlaceOrderDto } from '../mexc/dto/place-order.dto';

@UseGuards(JwtAuthGuard)
@Controller('gateio')
export class GateioController {
  constructor(
    private gateio: GateioService,
    private credentials: CredentialsService,
  ) {}

  private async getCreds(userId: string) {
    const c = await this.credentials.getDecrypted(userId, 'gateio');
    return { apiKey: c.apiKey, apiSecret: c.apiSecret };
  }

  // ── Public market data ───────────────────────────────────────────────────

  @Get('ticker')
  ticker() {
    return this.gateio.getTicker();
  }

  @Get('orderbook')
  orderbook(@Query('limit') limit?: string) {
    return this.gateio.getOrderBook(limit ? parseInt(limit) : 20);
  }

  @Get('trades')
  trades(@Query('limit') limit?: string) {
    return this.gateio.getRecentTrades(limit ? parseInt(limit) : 20);
  }

  // ── Authenticated endpoints ──────────────────────────────────────────────

  @Get('validate')
  async validate(@Request() req) {
    const creds = await this.getCreds(req.user.id);
    const valid = await this.gateio.validateCredentials(creds);
    return { valid };
  }

  @Get('balances')
  async balances(@Request() req) {
    const creds = await this.getCreds(req.user.id);
    return this.gateio.getBalances(creds);
  }

  @Get('orders/open')
  async openOrders(@Request() req) {
    const creds = await this.getCreds(req.user.id);
    return this.gateio.getOpenOrders(creds);
  }

  @Get('orders/history')
  async orderHistory(@Request() req) {
    const creds = await this.getCreds(req.user.id);
    return this.gateio.getOrderHistory(creds);
  }

  @Get('orders/:orderId')
  async orderStatus(@Request() req, @Param('orderId') orderId: string) {
    const creds = await this.getCreds(req.user.id);
    return this.gateio.getOrderStatus(creds, orderId);
  }

  @Post('orders')
  async placeOrder(@Request() req, @Body() dto: PlaceOrderDto) {
    const creds = await this.getCreds(req.user.id);
    return this.gateio.placeOrder(
      req.user.id,
      creds,
      dto.side,
      dto.type,
      dto.quantity,
      dto.price,
      dto.quoteOrderQty,
    );
  }

  @Delete('orders/:orderId')
  async cancelOrder(@Request() req, @Param('orderId') orderId: string) {
    const creds = await this.getCreds(req.user.id);
    return this.gateio.cancelOrder(creds, orderId);
  }
}
