import { SharedConfig } from '../config/engine-config';
import { EngineInstance, EngineSnapshot } from '../engine-instance';
import { Ledger } from '../ledger/ledger';
import { Alerter, Logger } from '../types';
import { VenueAdapter } from '../venue/venue';

export function summaryText(s: EngineSnapshot, title = 'Daily summary'): string {
  return [
    `📊 ${title}: ${s.pairId}`,
    `Status: ${s.status}${s.statusReason ? ` (${s.statusReason})` : ''} · epoch ${s.epoch ?? '-'}`,
    s.book ? `Market: bid ${s.book.bestBid} / ask ${s.book.bestAsk}` : 'Market: no data',
    `Rungs: ${Object.entries(s.rungsByState).map(([k, v]) => `${k} ${v}`).join(', ')} · live orders ${s.liveOrders}`,
    `Base owed: ${s.baseOwed} · Reserve: ${s.reserve} · Profit since sweep: ${s.profitSinceSweep}`,
    `Cycles completed: ${s.cyclesCompleted}`,
    `Last invariant check: ${s.lastInvariantCheck ? new Date(s.lastInvariantCheck).toISOString() : 'never'}${s.lastBreaches.length ? ` · breaches ${s.lastBreaches.map((b) => b.id).join(',')}` : ''}`,
  ].join('\n');
}

/**
 * Supervisor for one pair: owns the timers (ticks, lease renewal, REST cross-check, invariants,
 * heartbeat, self-healing restarts, daily summary). Stops sending orders the moment the lease is lost.
 */
export class PairRunner {
  private timers: NodeJS.Timeout[] = [];
  private stopFeeds: (() => Promise<void>) | null = null;
  private lastStatus = '';
  private lastSummaryDay = '';
  private finished!: () => void;
  readonly done = new Promise<void>((r) => { this.finished = r; });

  constructor(
    private readonly engine: EngineInstance,
    private readonly venue: VenueAdapter,
    private readonly o: { shared: SharedConfig; ledger: Ledger; alert: Alerter; log: Logger },
  ) {}

  async start(): Promise<void> {
    const { engine, venue, o } = this;
    this.stopFeeds = await venue.start({
      onBook: (b) => engine.onBook(b),
      onFill: (f) => engine.onFill(f),
      onOrderUpdate: (u) => engine.onOrderUpdate(u),
      onFeedStatus: (feed, c) => engine.onFeedStatus(feed, c),
    });
    const status = await engine.start();
    o.log.info(`[${engine.pairId}] started: ${status}`);
    if (status === 'STOPPED') {
      await this.stop('another instance holds the lease (standby)');
      return;
    }
    await o.alert.send(summaryText(engine.snapshot(), 'Engine started'));
    await this.heartbeat();

    const every = (ms: number, fn: () => Promise<unknown>) => {
      let busy = false;
      const t = setInterval(() => {
        if (busy) return;
        busy = true;
        fn().catch((e) => o.log.error(`[${engine.pairId}] ${(e as Error).message}`)).finally(() => { busy = false; });
      }, ms);
      this.timers.push(t);
    };

    every(1000, () => engine.tick());
    every(5000, async () => {
      if (!(await engine.renewLease())) await this.stop('lease lost');
    });
    every(engine.tuning.restPollMs, () => engine.poll());
    every(o.shared.invariantCheckSeconds * 1000, () => engine.checkNow('scheduled'));
    every(5000, async () => this.heartbeat());
    every(30_000, async () => {
      const s = engine.getStatus();
      if (s === 'PAUSED' || s === 'KILLED') await engine.recover();
      // A human cleared the kill switch in the control table: run the restart procedure.
      if (s === 'KILLED' && !(await o.ledger.isKilled(engine.pairId))) await engine.resume('control-table');
    });
  }

  private async heartbeat() {
    const s = this.engine.snapshot();
    await this.o.ledger.saveStatus(s.pairId, s.status, s.statusReason, s).catch((e) => this.o.log.warn(`status write failed: ${(e as Error).message}`));
    const status = `${s.status}:${s.statusReason ?? ''}`;
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.o.log.info(`[${s.pairId}] status ${status}`);
    }
    this.o.log.info(`[${s.pairId}] heartbeat ${s.status} owed=${s.baseOwed} profit=${s.profitSinceSweep} orders=${s.liveOrders}`);
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.lastSummaryDay && new Date().getUTCHours() === 0) {
      this.lastSummaryDay = day;
      await this.o.alert.send(summaryText(s));
    }
  }

  /** Stops timers and feeds. Resting orders stay on the book (they are real orders at our prices). */
  async stop(reason: string) {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.stopFeeds?.();
    this.stopFeeds = null;
    await this.engine.stop();
    const s = this.engine.snapshot();
    await this.o.ledger.saveStatus(s.pairId, 'STOPPED', reason, s).catch(() => undefined);
    this.o.log.info(`[${this.engine.pairId}] runner stopped: ${reason}`);
    this.finished();
  }
}
