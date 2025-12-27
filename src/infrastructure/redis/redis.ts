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
  const isTls = redisUrl.startsWith('rediss://');

  const config: RedisOptions = {
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false,
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    // Fix for "ECONNRESET" with some providers (Azure/Upstash)
    // trying to verify certificates strictly.
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