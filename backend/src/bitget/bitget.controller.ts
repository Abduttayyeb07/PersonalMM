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
  NotFoundException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BitgetService } from './bitget.service';
import { CredentialsService } from '../credentials/credentials.service';
import { PlaceOrderDto } from '../mexc/dto/place-order.dto';

@UseGuards(JwtAuthGuard)
@Controller('bitget')
export class BitgetController {
  constructor(
    private bitget: BitgetService,
    private credentials: CredentialsService,
  ) {}

  private async getCreds(userId: string) {
    const c = await this.credentials.getDecrypted(userId, 'bitget');
    if (!c.passphrase) throw new NotFoundException('Bitget passphrase missing');
    return { apiKey: c.apiKey, apiSecret: c.apiSecret, passphrase: c.passphrase };
  }

  // ── Public market data ───────────────────────────────────────────────────

  @Get('ticker')
  ticker() { return this.bitget.getTicker(); }

  @Get('orderbook')
  orderbook(@Query('limit') limit?: string) {
    return this.bitget.getOrderBook(limit ? parseInt(limit) : 20);
  }

  @Get('trades')
  trades(@Query('limit') limit?: string) {
    return this.bitget.getRecentTrades(limit ? parseInt(limit) : 20);
  }

  // ── Authenticated endpoints ──────────────────────────────────────────────

  @Get('validate')
  async validate(@Request() req) {
    const creds = await this.getCreds(req.user.id);
    const valid = await this.bitget.validateCredentials(creds);
    return { valid };
  }

  @Get('balances')
  async balances(@Request() req) {
    const creds = await this.getCreds(req.user.id);
    return this.bitget.getBalances(creds);
  }

  @Get('orders/open')
  async openOrders(@Request() req) {
    const creds = await this.getCreds(req.user.id);
    return this.bitget.getOpenOrders(creds);
  }

  @Get('orders/history')
  async orderHistory(@Request() req) {
    const creds = await this.getCreds(req.user.id);
    return this.bitget.getOrderHistory(creds);
  }

  @Get('orders/:orderId')
  async orderStatus(@Request() req, @Param('orderId') orderId: string) {
    const creds = await this.getCreds(req.user.id);
    return this.bitget.getOrderStatus(creds, orderId);
  }

  @Post('orders')
  async placeOrder(@Request() req, @Body() dto: PlaceOrderDto) {
    const creds = await this.getCreds(req.user.id);
    return this.bitget.placeOrder(
      req.user.id, creds,
      dto.side, dto.type, dto.quantity, dto.price, dto.quoteOrderQty,
    );
  }

  @Delete('orders/:orderId')
  async cancelOrder(@Request() req, @Param('orderId') orderId: string) {
    const creds = await this.getCreds(req.user.id);
    return this.bitget.cancelOrder(creds, orderId);
  }
}
