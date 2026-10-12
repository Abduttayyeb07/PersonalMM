import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(request: Record<string, any>): Promise<string> {
    const token = request.cookies?.access_token as string | undefined;
    if (token) {
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        if (typeof payload.sub === 'string') return `user:${payload.sub}`;
      } catch { /* Authentication still validates the token; use IP for malformed tokens. */ }
    }
    return `ip:${request.ip}`;
  }
}
