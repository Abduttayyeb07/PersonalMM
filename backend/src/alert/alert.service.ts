import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);
  private readonly token: string;
  private readonly chatId: string;
  private readonly enabled: boolean;

  constructor(config: ConfigService) {
    this.token  = config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';
    this.chatId = config.get<string>('TELEGRAM_ADMIN_ID')  ?? '';
    this.enabled = !!(this.token && this.chatId);
  }

  async send(text: string): Promise<void> {
    if (!this.enabled) return;
    await axios
      .post(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        chat_id:    this.chatId,
        text,
        parse_mode: 'HTML',
      })
      .catch((err) => this.logger.error(`Failed to send alert: ${err?.message}`));
  }
}
