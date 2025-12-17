// src/scripts/recover-jobs.ts
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

const connection = new Redis(process.env.REDIS_URL!);
const queue = new Queue('webhook-queue', { connection });

async function recover() {
  console.log('🚑 Starting Job Rescue...');

  const counts = await queue.getJobCounts();
  console.log('Current Queue Status:', counts);

  const activeJobs = await queue.getJobs(['active']);
  console.log(`Found ${activeJobs.length} stuck active jobs.`);

  for (const job of activeJobs) {
    console.log(`Re-queuing stuck job ${job.id}...`);
    
    // FIX: Provide a fallback string for the token
    // The token is technically required to "unlock" the job securely, 
    // but in a rescue script, we assume ownership.
    await job.moveToFailed(new Error('Worker crashed'), job.token || '0');
    
    await job.retry(); 
  }

  console.log('✅ Recovery complete. Start your worker now.');
  process.exit(0);
}

recover();