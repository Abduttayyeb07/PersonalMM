import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CredentialsService } from './credentials.service';
import { SaveCredentialsDto } from './dto/save-credentials.dto';
import { DeleteCredentialsDto } from './dto/delete-credentials.dto';

function metadata(req: Request) {
  return { ip: req.ip, userAgent: req.get('user-agent') };
}

@UseGuards(JwtAuthGuard)
@Controller('credentials')
export class CredentialsController {
  constructor(private credentials: CredentialsService) {}

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post()
  save(@Req() req: any, @Body() dto: SaveCredentialsDto) {
    return this.credentials.save(req.user.id, dto, metadata(req));
  }

  @Get()
  list(@Req() req: any) {
    return this.credentials.listConnected(req.user.id);
  }

  @Post(':exchange/test')
  test(@Req() req: any, @Param('exchange') exchange: ExchangeParam) {
    return this.credentials.test(req.user.id, exchange, metadata(req));
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Delete(':exchange')
  remove(@Req() req: any, @Param('exchange') exchange: ExchangeParam, @Body() dto: DeleteCredentialsDto) {
    return this.credentials.remove(req.user.id, exchange, dto.accountPassword, metadata(req));
  }
}

type ExchangeParam = 'mexc' | 'bybit';
