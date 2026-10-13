import { Logger } from '../engine/types';
import { VenueAdapter } from '../engine/venue/venue';
import { SeriesEngine } from './engine';

/**
 * Owns the timers of one running series: ticks, lease renewal, REST cross-checks, heartbeat for the
 * dashboard, and self-healing after a lost feed. Resting orders are cancelled only by stop().
 */
export class SeriesRunner {
  private timers: NodeJS.Timeout[] = [];
  private stopFeeds: (() => Promise<void>) | null = null;
  private finished!: () => void;
  readonly done = new Promise<void>((r) => { this.finished = r; });

  constructor(private readonly engine: SeriesEngine, private readonly venue: VenueAdapter, private readonly log: Logger) {}

  async start(resume?: Parameters<SeriesEngine['start']>[0]) {
    const { engine, venue } = this;
    this.stopFeeds = await venue.start({
      onBook: (b) => engine.onBook(b),
      onFill: (f) => engine.onFill(f),
      onOrderUpdate: (u) => engine.onOrderUpdate(u),
      onFeedStatus: (feed, c) => engine.onFeedStatus(feed, c),
    });
    let status;
    try {
      status = await engine.start(resume);
    } catch (e) {
      await this.shutdown();
      throw e;
    }
    await engine.heartbeat();
    if (status === 'STOPPED') {
      await this.shutdown();
      return;
    }
    const every = (ms: number, fn: () => Promise<unknown>) => {
      let busy = false;
      this.timers.push(setInterval(() => {
        if (busy) return;
        busy = true;
        fn().catch((e) => this.log.error(`${(e as Error).message}`)).finally(() => { busy = false; });
      }, ms));
    };
    every(1000, () => engine.tick());
    every(5000, async () => { if (!(await engine.renewLease())) await this.shutdown(); });
    every(5000, () => engine.heartbeat());
    every(10_000, () => engine.recover());
    every(30_000, () => engine.poll());
    every(60_000, () => engine.checkNow());
  }

  private async shutdown() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.stopFeeds?.();
    this.stopFeeds = null;
    this.finished();
  }

  /** Process shutdown: timers and feeds stop, the series stays RUNNING in the store so it can resume. */
  async detach() {
    await this.shutdown();
  }

  /** The user ends the series: orders are removed and the timers stop. */
  async stop(reason: string) {
    const snapshot = await this.engine.stop(reason);
    await this.engine.heartbeat();
    await this.shutdown();
    return snapshot;
  }
}
