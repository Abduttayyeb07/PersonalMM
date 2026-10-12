import { Body, Controller, Post, Get, HttpCode, HttpStatus, Res, UseGuards, Request } from '@nestjs/common';
import { Response } from 'express';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Throttle } from '@nestjs/throttler';

const COOKIE_NAME = 'access_token';
const COOKIE_TTL_MS = 1 * 24 * 60 * 60 * 1000;

function setAuthCookie(res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'strict',
    maxAge: COOKIE_TTL_MS,
  });
}

@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private jwt: JwtService,
  ) {}

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto);
    setAuthCookie(res, result.accessToken);
    return { email: result.email };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Request() req: any, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.['access_token'];
    if (token) {
      try {
        const payload = this.jwt.decode(token) as any;
        if (payload?.jti) await this.auth.revokeToken(payload.jti);
      } catch { /* malformed token — just clear cookie */ }
    }
    res.clearCookie(COOKIE_NAME, { sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true' });
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Request() req: any) {
    return { email: req.user.email };
  }
}
