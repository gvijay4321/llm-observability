import { config } from '../config.js';
import { MemoryQueue } from './memory.js';
import { RedisQueue } from './redis.js';

// The queue carries pointers to persisted raw_events, not payloads.
export interface IngestionEvent {
  rawEventId: string;
}

export type EventHandler = (event: IngestionEvent) => Promise<void>;

// Drivers: 'memory' (local/dev default) and 'redis' (BullMQ, durable).
export interface EventQueue {
  publish(event: IngestionEvent): Promise<void>;
  consume(handler: EventHandler): Promise<void>;
  // Pending-events count, used by the queue-depth telemetry gauge.
  depth(): Promise<number>;
  close(): Promise<void>;
}

export function createQueue(): EventQueue {
  if (config.queue.driver === 'redis') {
    return new RedisQueue(config.queue.redisUrl, config.workerConcurrency);
  }
  return new MemoryQueue(config.workerConcurrency);
}
