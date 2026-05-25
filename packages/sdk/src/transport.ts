import type { InferenceLog } from '@obs/shared';

export interface ShipperOptions {
  // Omit to silently discard logs.
  url?: string;
  apiKey?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  maxRetries?: number;
}

// Fire-and-forget. enqueue() never blocks; shipping failures never surface.
export class LogShipper {
  private readonly url?: string;
  private readonly apiKey?: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;

  private buffer: InferenceLog[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(opts: ShipperOptions = {}) {
    this.url = opts.url?.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.batchSize = opts.batchSize ?? 10;
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  enqueue(log: InferenceLog): void {
    if (!this.url) return;
    this.buffer.push(log);
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushIntervalMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.url || this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];
    // Serialise to preserve order. A rejection in deliver() must not poison
    // the chain — deliver already swallows errors, but guard anyway so a
    // future change doesn't break every subsequent flush.
    const next = this.inFlight.then(() => this.deliver(batch)).catch(() => undefined);
    this.inFlight = next;
    await next;
  }

  private async deliver(logs: InferenceLog[]): Promise<void> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(`${this.url}/v1/logs`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({ logs }),
        });
        // 4xx (except 429): bad payload, don't retry.
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
          return;
        }
        throw new Error(`ingestion HTTP ${res.status}`);
      } catch {
        if (attempt === this.maxRetries) return;
        await sleep(200 * 2 ** attempt + Math.random() * 100);
      }
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.inFlight;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
