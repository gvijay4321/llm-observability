import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { EventQueue } from './queue/index.js';
import { registerRoutes } from './routes.js';

export async function buildServer(queue: EventQueue): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 1_048_576,
  });

  // Browser dashboard can call the API directly in dev.
  await app.register(cors, { origin: true });

  registerRoutes(app, queue);
  return app;
}
