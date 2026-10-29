// StateBackend over an in-process Store (Node/Railway and Vercel entries).
import type {
  Envelope,
  IngestResult,
  SessionView,
  StateBackend,
  StateOptions,
  StateResponse,
  Store,
} from '@jfm/core';

export type { StateBackend } from '@jfm/core';

/** Wraps a Store and runs `store.init()` lazily, once (retried if it failed). */
export class LocalBackend implements StateBackend {
  private ready: Promise<void> | null = null;

  constructor(readonly store: Store) {}

  /** Idempotent; concurrent callers share one init. */
  init(): Promise<void> {
    if (!this.ready) {
      this.ready = this.store.init().catch((err: unknown) => {
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  get driverName(): string {
    return this.store.driver.name;
  }

  async ingest(envelopes: Envelope[], host: string): Promise<IngestResult> {
    await this.init();
    return this.store.ingest(envelopes, host);
  }

  async state(opts: StateOptions): Promise<StateResponse | null> {
    await this.init();
    return this.store.state(opts);
  }

  async session(key: string): Promise<SessionView | null> {
    await this.init();
    return this.store.session(key);
  }
}
