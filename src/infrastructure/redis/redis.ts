// src/infrastructure/redis/redis.ts
import { Redis } from 'ioredis';

// Ensure we have the URL
const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error('REDIS_URL is not defined in .env');
}

// 1. Create a singleton Redis instance for general use (Caching, Counters)
// maxRetriesPerRequest: null is required for BullMQ compatibility if you use this connection there
export const redisClient = new Redis(redisUrl, {
  maxRetriesPerRequest: null, 
  enableReadyCheck: false
});

// Optional: Log connection errors
redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err);
});

redisClient.on('connect', () => {
  console.log('✅ Connected to Redis');
});