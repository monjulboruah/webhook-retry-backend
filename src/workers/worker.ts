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
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100, rejectUnauthorized: true });

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

  // --- Traffic Smoothing Logic (Proportional Delay) ---
  const limit = event.endpoint.rateLimit || 5;
  const now = Math.floor(Date.now() / 1000);
  const key = `rate:${event.endpoint.id}:${now}`;
  const currentCount = await redisClient.incr(key);
  if (currentCount === 1) await redisClient.expire(key, 60);

  // Calculate delay based on how many "batches" deep we are
  // e.g. Limit 5.
  // Count 1-5: Window 0 -> Delay 0ms
  // Count 6-10: Window 1 -> Delay 1000ms
  // Count 11-15: Window 2 -> Delay 2000ms
  const windowIndex = Math.floor((currentCount - 1) / limit);

  if (windowIndex > 0) {
    const delayMs = windowIndex * 1000;
    console.log(`🚦 Smoothing: Delaying request ${event.id} by ${delayMs}ms (Window ${windowIndex})`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  // ------------------------------------------

  const startTime = Date.now();

  try {
    // Check if URL is Localhost (Fatal in Prod)
    if (event.endpoint.targetUrl.includes('localhost') || event.endpoint.targetUrl.includes('127.0.0.1')) {
      console.error("🚨 FATAL: You are trying to hit localhost from inside a Render container. This will never work.");
    }

    // 1. Create a Clean Copy of Headers
    const headers = { ...(event.headers as Record<string, any> || {}) };

    // 2. Remove "Forbidden" Headers that break routing/payloads
    delete headers['host'];             // <--- THE FIX
    delete headers['content-length'];   // Let Axios calculate this
    delete headers['connection'];
    delete headers['accept-encoding'];  // Let Axios handle compression

    const response = await axios.post(event.endpoint.targetUrl, event.payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Buffer-ID': event.id,
        ...headers,
      },
      timeout: 5000,
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