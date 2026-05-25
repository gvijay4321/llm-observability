import type { EventHandler, EventQueue, IngestionEvent } from './index.js';

// In-process FIFO with bounded concurrency. Single-node only; durability
// comes from raw_events being written before publish + a pending-scan on boot.
export class MemoryQueue implements EventQueue {
  private readonly buffer: IngestionEvent[] = [];
  private handler: EventHandler | null = null;
  private active = 0;
  private closed = false;

  constructor(private readonly concurrency: number) {}

  async publish(event: IngestionEvent): Promise<void> {
    if (this.closed) return;
    this.buffer.push(event);
    this.pump();
  }

  async consume(handler: EventHandler): Promise<void> {
    this.handler = handler;
    this.pump();
  }

  private pump(): void {
    while (this.handler && !this.closed && this.active < this.concurrency && this.buffer.length > 0) {
      const event = this.buffer.shift()!;
      this.active += 1;
      this.handler(event)
        .catch(() => {})
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  async depth(): Promise<number> {
    return this.buffer.length + this.active;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
