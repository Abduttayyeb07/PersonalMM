import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AlertService } from '../alert/alert.service';
import { redact } from './redact';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private alert: AlertService) {}

  async catch(exception: unknown, host: ArgumentsHost) {
    const ctx    = host.switchToHttp();
    const req    = ctx.getRequest<Request>();
    const res    = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const rawMessage =
      exception instanceof HttpException
        ? (exception.getResponse() as any)?.message ?? exception.message
        : 'Internal server error';
    const message = this.scrub(rawMessage);

    // Only alert on genuine server errors (not 4xx client errors)
    if (status >= 500) {
      const now = new Date().toUTCString();
      this.logger.error(`[${req.method} ${req.path}] ${status}: ${String(message).slice(0, 200)}`);
      await this.alert.send(
        `🚨 <b>Server error ${status}</b>\n` +
        `📍 ${req.method} ${req.url}\n` +
        `💬 ${String(message).slice(0, 200)}\n` +
        `🕐 ${now}`,
      );
    }

    res.status(status).json({
      statusCode: status,
      message,
    });
  }

  private scrub(value: unknown): string | string[] {
    const clean = (text: string) => redact(text).slice(0, 500);
    return Array.isArray(value) ? value.map((v) => clean(String(v))) : clean(String(value));
  }
}
