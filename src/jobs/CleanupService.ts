import { PrismaClient } from '@prisma/client';
import cron from 'node-cron';

export class CleanupService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  // Initialize the Cron Job (Runs every day at Midnight: 00:00)
  startCron() {
    console.log('⏰ Cleanup Cron Scheduled: Daily at 00:00');
    
    cron.schedule('0 0 * * *', async () => {
      console.log('🧹 Starting Database Cleanup Job...');
      await this.runCleanup();
    });
  }

  // The Logic
  async runCleanup() {
    const RETENTION_DAYS = 7; // Configurable: Delete success events older than 7 days
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);

    try {
      // 1. Group by Endpoint to get counts BEFORE deleting
      // We only target 'COMPLETED' events (Success tags)
      const eventsToArchive = await this.prisma.webhookEvent.groupBy({
        by: ['endpointId'],
        where: {
          status: 'COMPLETED',
          receivedAt: {
            lt: cutoffDate // "Less than" 7 days ago
          }
        },
        _count: {
          id: true
        }
      });

      if (eventsToArchive.length === 0) {
        console.log('✅ No old events to clean up today.');
        return;
      }

      console.log(`📦 Archiving events for ${eventsToArchive.length} endpoints...`);

      // 2. Perform Transaction: Update Counters + Delete Rows
      // We loop because we need to update each endpoint specifically
      for (const group of eventsToArchive) {
        const count = group._count.id;
        const endpointId = group.endpointId;

        await this.prisma.$transaction([
          // A. Increment the permanent counter (Preserve history)
          this.prisma.endpoint.update({
            where: { id: endpointId },
            data: {
              archivedSuccessCount: { increment: count }
            }
          }),

          // B. Delete the raw rows (Free up space)
          this.prisma.webhookEvent.deleteMany({
            where: {
              endpointId: endpointId,
              status: 'COMPLETED',
              receivedAt: { lt: cutoffDate }
            }
          })
        ]);
        
        console.log(`   -> Endpoint ${endpointId}: Archived & Deleted ${count} events.`);
      }

      console.log('🎉 Cleanup Job Completed Successfully.');

    } catch (error) {
      console.error('❌ Cleanup Job Failed:', error);
    }
  }
}