// src/infrastructure/queue/QueueService.ts
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { redisClient } from '../redis/redis';

// const connection = new Redis(process.env.REDIS_URL!, {
//   maxRetriesPerRequest: null
// });

export class QueueService {
  private queue: Queue;

  constructor(queueName: string) {
    this.queue = new Queue(queueName, { 
      connection: redisClient 
    });
  }

  async addJob(name: string, data: any) {
    // ... inside your addJob method ...

    return this.queue.add(name, data, {
      // 1. EXTEND RETRIES TO ~15 DAYS
      // 2^18 * 5 seconds ≈ 1,310,720 seconds ≈ 15 days
      attempts: 18, 

      // 2. ENABLE EXPONENTIAL BACKOFF
      backoff: {
        type: 'exponential',
        delay: 5000 // Start with 5 seconds delay (then 10s, 20s, 40s...)
      },

      // 3. CLEANUP (Keep memory low)
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 } // Keep failed jobs for 7 days
    });
  }

  async addJobsBulk(jobs: { name: string; data: any }[]) {
    // Map our simple data to BullMQ structure
    const bulkData = jobs.map(j => ({
      name: j.name,
      data: j.data,
      opts: {
        attempts: 18, // Ensure these "resurrected" jobs get the new exponential logic
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 }
      }
    }));

    return this.queue.addBulk(bulkData);
  }
}