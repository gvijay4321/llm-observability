import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { EventHandler, EventQueue, IngestionEvent } from './index.js';

const QUEUE_NAME = 'inference-logs';

export class RedisQueue implements EventQueue {
  private readonly connection: Redis;
  private readonly queue: Queue;
  private worker: Worker | null = null;

  constructor(redisUrl: string, private readonly concurrency: number) {
    // maxRetriesPerRequest must be null for BullMQ's blocking commands.
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
  }

  async publish(event: IngestionEvent): Promise<void> {
    await this.queue.add('event', event, {
      attempts: 4,
      backoff: { type: 'exponential', delay: 500 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async consume(handler: EventHandler): Promise<void> {
    const worker = new Worker<IngestionEvent>(
      QUEUE_NAME,
      async (job) => handler(job.data),
      { connection: this.connection, concurrency: this.concurrency },
    );
    worker.on('error', (err) => {
      // Surface connection / driver errors instead of silently retrying forever.
      console.error('[queue] worker error:', err);
    });
    // Throws on bad credentials / unreachable Redis instead of resolving silently.
    await worker.waitUntilReady();
    this.worker = worker;
  }

  async depth(): Promise<number> {
    // Active + waiting jobs; matches the "queue depth" intuition operators want.
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed');
    return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit();
  }
}
