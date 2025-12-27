// src/infrastructure/redis/redis.ts
import { Redis, RedisOptions } from 'ioredis';

// Ensure we have the URL
const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error('REDIS_URL is not defined in .env');
}

/**
 * Helper to create Redis instances with consistent settings.
 * Automatically enables TLS if the URL is 'rediss://'
 * or if we are connecting to a known provider needing it.
 */
export const createRedisConfig = (): RedisOptions => {
  // 1. Parse the URL to check hostname
  const parsed = new URL(redisUrl);
  const isUpstash = parsed.hostname.includes('upstash.io');

  // 2. Determine if TLS is needed (rediss:// OR Upstash)
  const isTls = redisUrl.startsWith('rediss://') || isUpstash;

  const config: RedisOptions = {
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false,
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    family: 4, // Force IPv4 to prevent Node 17+ / Upstash ECONNRESET issues

    // 3. Apply TLS if needed
    tls: isTls ? {
      rejectUnauthorized: false
    } : undefined
  };
  return config;
};

// 1. Create a singleton Redis instance for general use (Caching, Counters)
export const redisClient = new Redis(redisUrl, createRedisConfig());

// Optional: Log connection errors
redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err);
});

redisClient.on('connect', () => {
  console.log('✅ Connected to Redis (General)');
});