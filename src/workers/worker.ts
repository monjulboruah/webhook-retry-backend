import 'dotenv/config';
import { Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { Redis } from 'ioredis';
import https from 'https';
import http from 'http';
import { BatchLogger } from '../infrastructure/logger/BatchLogger'; // <--- Import
import { createRedisConfig } from '../infrastructure/redis/redis';

// OPTIMIZATION 1: Keep-Alive Agents (Reuses TCP connections)
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100, rejectUnauthorized: false });

const connection = new Redis(process.env.REDIS_URL!, createRedisConfig());
const redisClient = new Redis(process.env.REDIS_URL!, createRedisConfig());
const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

// OPTIMIZATION 2: Initialize Batch Logger
const batchLogger = new BatchLogger(prisma);

console.log("🚀 High-Performance Worker started...");

const worker = new Worker('webhook-queue', async (job) => {
  const { eventId } = job.data;

  const event = await prisma.webhookEvent.findUnique({
    where: { id: eventId },
    include: { endpoint: true }
  });

  if (!event) return;

  // --- Traffic Smoothing Logic (Existing) ---
  const limit = event.endpoint.rateLimit || 5;
  const now = Math.floor(Date.now() / 1000);
  const key = `rate:${event.endpoint.id}:${now}`;
  const currentCount = await redisClient.incr(key);
  if (currentCount === 1) await redisClient.expire(key, 5);

  if (currentCount > limit) {
    // Simple pause for traffic smoothing
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  // ------------------------------------------

  const startTime = Date.now();

  try {
    const response = await axios.post(event.endpoint.targetUrl, event.payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Buffer-ID': event.id,
        ...(event.headers as Record<string, any> || {})
      },
      timeout: 5000,
      httpAgent,   // <--- Use Optimized Agents
      httpsAgent
    });

    // OPTIMIZATION 3: Batch Log Success
    batchLogger.add({
      webhookEventId: event.id,
      success: true,
      responseStatus: response.status,
      responseBody: 'OK', // Don't save full body to save DB space
      attemptedAt: new Date()
    });

    // Update status (This is light, so we can keep doing it individually or batch it too)
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: { status: 'COMPLETED' }
    });

  } catch (error: any) {
    const status = error.response ? error.response.status : 500;

    // ============================================================
    // 🧠 EXPONENTIAL RETRY EXTENSION
    // ============================================================

    // Check if this is a "Fatal" error (Client Error 4xx)
    // We do NOT want to retry these for 15 days!
    const isFatalError = (status >= 400 && status < 500)
      && status !== 429 // Too Many Requests -> Retry
      && status !== 408 // Timeout -> Retry
      && status !== 404; // Nginx Crash (Special Case) -> Retry

    if (isFatalError) {
      console.log(`🛑 Non-retriable error (${status}). Failing permanently.`);

      // Log Failure
      batchLogger.add({
        webhookEventId: event.id,
        success: false,
        responseStatus: status,
        responseBody: error.message,
        attemptedAt: new Date()
      });

      // Update DB
      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: 'FAILED' }
      });
      return; // Stop BullMQ retries
    }

    // ============================================================
    // 🔄 RETRY LOGIC (500s, Network Errors, timeouts)
    // ============================================================

    // Calculate how long we will wait (for logging purposes)
    // Formula: delay * (2 ^ (attemptsMade - 1))
    const nextDelayMs = 5000 * Math.pow(2, job.attemptsMade);
    const nextRetryTime = new Date(Date.now() + nextDelayMs);

    console.log(`⚠️ Attempt ${job.attemptsMade + 1} failed. Next retry in ${nextDelayMs / 1000}s (@ ${nextRetryTime.toLocaleTimeString()})`);

    // Log the attempt
    batchLogger.add({
      webhookEventId: event.id,
      success: false,
      responseStatus: status,
      responseBody: `Failed (Attempt ${job.attemptsMade + 1}): ${error.message}`,
      attemptedAt: new Date()
    });

    // Throwing error triggers BullMQ's exponential backoff configured in QueueService
    throw error;
  }
}, {
  connection,
  concurrency: 20 // <--- OPTIMIZATION 4: Process 20 jobs at once (Safe for 512MB Free Tier)
});

// 👇 ADD THIS BLOCK TO HANDLE FINAL FAILURES
worker.on('failed', async (job, err) => {
  if (job) {
    console.log(`Job ${job.id} failed: ${err.message}`);

    // Check if we have used up all retry attempts
    // job.attemptsMade starts at 0. If attemptsMade >= opts.attempts, it's dead.
    if (job.attemptsMade >= (job.opts.attempts || 0)) {
      console.log(`💀 Job ${job.id} is dead. Marking as FAILED in DB.`);

      try {
        await prisma.webhookEvent.update({
          where: { id: job.data.eventId },
          data: { status: 'FAILED' }
        });
      } catch (dbErr) {
        console.error('Failed to update status to FAILED:', dbErr);
      }
    }
  }
});

// Graceful Shutdown: Flush logs before killing process
process.on('SIGINT', async () => {
  console.log('Closing worker...');
  await batchLogger.flush();
  await worker.close();
  process.exit(0);
});