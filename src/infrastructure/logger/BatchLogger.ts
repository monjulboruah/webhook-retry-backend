// src/infrastructure/logger/BatchLogger.ts
import { PrismaClient } from '@prisma/client';

interface LogEntry {
  webhookEventId: string;
  success: boolean;
  responseStatus: number;
  responseBody: string;
  attemptedAt: Date;
}

export class BatchLogger {
  private buffer: LogEntry[] = [];
  private readonly BATCH_SIZE = 100; // Flush after 100 logs
  private readonly FLUSH_INTERVAL = 5000; // Flush every 5 seconds
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;

    // Start the timer to auto-flush even if buffer isn't full
    setInterval(() => this.flush(), this.FLUSH_INTERVAL);
  }

  // 1. Add log to memory buffer
  add(entry: LogEntry) {
    this.buffer.push(entry);

    // If buffer is full, flush immediately
    if (this.buffer.length >= this.BATCH_SIZE) {
      this.flush();
    }
  }

  // 2. Write buffer to Database
  async flush() {
    if (this.buffer.length === 0) return;

    const dataToWrite = [...this.buffer]; // Copy buffer
    this.buffer = []; // Clear buffer immediately

    try {
      console.log(`💾 Batch Logger: Saving ${dataToWrite.length} logs to DB...`);
      
      // Efficient Bulk Insert
      await this.prisma.deliveryAttempt.createMany({
        data: dataToWrite
      });
    } catch (err) {
      console.error('🔥 Batch Logger Failed:', err);
      // In a real app, you might write this to a file as a backup
    }
  }
}