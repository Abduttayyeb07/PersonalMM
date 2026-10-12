import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AlertService } from '../alert/alert.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

const TOKEN_TTL_DAYS = 1;

// Track consecutive failures per email to avoid alerting on every single attempt
const failCounts = new Map<string, number>();

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private alert: AlertService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.user.create({
      data: { email: dto.email, passwordHash },
    });

    return this.signToken(user.id, user.email);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      await this.handleFailedLogin(dto.email);
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      await this.handleFailedLogin(dto.email);
      throw new UnauthorizedException('Invalid credentials');
    }

    failCounts.delete(dto.email);
    const now = new Date().toUTCString();
    await this.alert.send(`🔐 <b>Login</b>\n👤 ${dto.email}\n🕐 ${now}`);

    return this.signToken(user.id, user.email);
  }

  async verifyPassword(userId: string, password: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid account password');
    }
  }

  private async handleFailedLogin(email: string) {
    const count = (failCounts.get(email) ?? 0) + 1;
    failCounts.set(email, count);
    // Alert on 1st attempt and every 5th after that
    if (count === 1 || count % 5 === 0) {
      const now = new Date().toUTCString();
      await this.alert.send(
        `⚠️ <b>Failed login attempt</b>\n👤 ${email}\n🔢 ${count} attempt${count > 1 ? 's' : ''}\n🕐 ${now}`,
      );
    }
  }

  async revokeToken(jti: string) {
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await this.prisma.revokedToken.upsert({
      where:  { jti },
      update: {},
      create: { jti, expiresAt },
    });
    // Purge expired revoked tokens to keep the table small
    await this.prisma.revokedToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  }

  signToken(userId: string, email: string) {
    const jti = randomUUID();
    const expiresIn = `${TOKEN_TTL_DAYS}d`;
    const accessToken = this.jwt.sign({ sub: userId, email, jti }, { expiresIn });
    return { accessToken, userId, email, jti };
  }
}
