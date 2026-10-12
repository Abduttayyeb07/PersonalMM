import { Injectable } from '@nestjs/common';

type Cleanup = (userId: string) => Promise<void> | void;

@Injectable()
export class CredentialLifecycleService {
  private readonly cleanup = new Map<string, Cleanup>();

  register(exchange: string, cleanup: Cleanup) {
    this.cleanup.set(exchange, cleanup);
  }

  async disconnect(userId: string, exchange: string) {
    await this.cleanup.get(exchange)?.(userId);
  }
}
