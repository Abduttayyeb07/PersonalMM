import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return true;
    if (request.get('X-Requested-With') !== 'zig') {
      throw new UnauthorizedException('Missing request verification header');
    }
    return true;
  }
}
