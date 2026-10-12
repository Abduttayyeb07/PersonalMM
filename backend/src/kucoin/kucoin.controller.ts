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
import { KucoinService } from './kucoin.service';
import { CredentialsService } from '../credentials/credentials.service';
import { PlaceOrderDto } from '../mexc/dto/place-order.dto';

@UseGuards(JwtAuthGuard)
@Controller('kucoin')
export class KucoinController {
  constructor(
    private kucoin: KucoinService,
    private credentials: CredentialsService,
  ) {}

  private async getCreds(userId: string) {
    const c = await this.credentials.getDecrypted(userId, 'kucoin');
    if (!c.passphrase) {
      throw new Error('KuCoin passphrase missing');
    }
    return { apiKey: c.apiKey, apiSecret: c.apiSecret, passphrase: c.passphrase };
  }

  // ── Public market data ───────────────────────────────────────────────────

  @Get('ticker')
  ticker() {
    return this.kucoin.getTicker();
  }

  @Get('orderbook')
  orderbook(@Query('limit') limit?: string) {
    return this.kucoin.getOrderBook(limit ? parseInt(limit) : 20);
  }

  @Get('trades')
  trades(@Query('limit') limit?: string) {
    return this.kucoin.getRecentTrades(limit ? parseInt(limit) : 20);
  }

  // ── Authenticated endpoints ──────────────────────────────────────────────

  @Get('validate')
  async validate(@Request() req) {
    const creds = await this.getCreds(req.user.id);
    const valid = await this.kucoin.validateCredentials(creds);
    return { valid };
  }

  @Get('balances')
  async balances(@Request() req) {
    const creds = await this.getCreds(req.user.id);
    return this.kucoin.getBalances(creds);
  }

  @Get('orders/open')
  async openOrders(@Request() req) {
    const creds = await this.getCreds(req.user.id);
    return this.kucoin.getOpenOrders(creds);
  }

  @Get('orders/history')
  async orderHistory(@Request() req) {
    const creds = await this.getCreds(req.user.id);
    return this.kucoin.getOrderHistory(creds);
  }

  @Get('orders/:orderId')
  async orderStatus(@Request() req, @Param('orderId') orderId: string) {
    const creds = await this.getCreds(req.user.id);
    return this.kucoin.getOrderStatus(creds, orderId);
  }

  @Post('orders')
  async placeOrder(@Request() req, @Body() dto: PlaceOrderDto) {
    const creds = await this.getCreds(req.user.id);
    return this.kucoin.placeOrder(
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
    return this.kucoin.cancelOrder(creds, orderId);
  }
}
