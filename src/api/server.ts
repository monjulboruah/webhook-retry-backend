import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import rawBody from 'fastify-raw-body';
import { CleanupService } from '../jobs/CleanupService';
import { QueueService } from '../infrastructure/queue/QueueService';
import { redisClient } from '../infrastructure/redis/redis';
import { IngestionService } from '../core/services/IngestionService';
import { authRoutes } from './auth';
import { authenticate } from './middleware';
import { isSafeUrl } from '../utils/urlValidator';

const fastify = Fastify({ logger: true, bodyLimit: 1048576 });

// 1. Initialize Prisma (Standard v5/v6 syntax)
const prisma = new PrismaClient();

// 2. Initialize Queue & Services
const queue = new QueueService('webhook-queue');
const ingestionService = new IngestionService(prisma, queue);

// 👇 INITIALIZE CLEANUP JOB
const cleanupService = new CleanupService(prisma);
cleanupService.startCron();

// 3. Register Plugins
fastify.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE']
});

fastify.register(rawBody, {
  field: 'rawBody', // Attaches the raw buffer to req.rawBody
  global: false,    // Only run for specific routes (performance optimization)
  encoding: 'utf8',
  runFirst: true,
});

fastify.register(authRoutes);

// =========================================================
//  SECURED ROUTES (Dashboard & Management)
// =========================================================

// GET /endpoints - List User's Endpoints
fastify.get('/endpoints', { preHandler: [authenticate] }, async (request, reply) => {
  const endpoints = await prisma.endpoint.findMany({
    where: {
      userId: request.user.userId
    },
    include: {
      _count: { select: { events: true } }
    }
  });
  return endpoints;
});

// POST /endpoints - Create New Endpoint
fastify.post('/endpoints', { preHandler: [authenticate] }, async (request, reply) => {
  const data = request.body as any;
  const { targetUrl } = data || '';

  if (!(await isSafeUrl(targetUrl))) {
    return reply.status(400).send({ error: 'Target URL is not allowed (Private/Local IPs blocked)' });
  }

  if (!data.name || !data.targetUrl) {
    return reply.status(400).send({ error: 'Name and Target URL are required' });
  }

  try {
    const endpoint = await prisma.endpoint.create({
      data: {
        name: data.name,
        targetUrl: data.targetUrl,
        provider: data.provider || 'generic',
        rateLimit: Number(data.rateLimit) || 5,
        secret: data.secret,
        userId: request.user.userId
      }
    });
    return endpoint;
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Failed to create endpoint' });
  }
});

// GET /endpoints/:id/events - List Events
fastify.get('/endpoints/:id/events', { preHandler: [authenticate] }, async (request, reply) => {
  const { id } = request.params as any;

  // Security: Check ownership
  const endpoint = await prisma.endpoint.findFirst({
    where: {
      id: id,
      userId: request.user.userId
    }
  });

  if (!endpoint) {
    return reply.status(404).send({ error: 'Endpoint not found or access denied' });
  }

  const events = await prisma.webhookEvent.findMany({
    where: { endpointId: id },
    include: { attempts: true },
    orderBy: { receivedAt: 'desc' },
    take: 50
  });
  return events;
});

// POST /events/:id/replay - The Replay Logic
fastify.post('/events/:id/replay', { preHandler: [authenticate] }, async (request, reply) => {
  const { id } = request.params as any;

  // Security: Check ownership via parent endpoint
  const event = await prisma.webhookEvent.findFirst({
    where: {
      id,
      endpoint: {
        userId: request.user.userId
      }
    }
  });

  if (!event) {
    return reply.status(404).send({ error: 'Event not found or access denied' });
  }

  // Logic: Reset status and push to queue
  await prisma.webhookEvent.update({
    where: { id },
    data: { status: 'PENDING' }
  });

  await queue.addJob('dispatch-webhook', { eventId: id });

  request.log.info(`Replaying event ${id}`);

  return { success: true, message: 'Replay queued successfully' };
});


// =========================================================
//  PUBLIC ROUTES (Webhook Ingestion)
// =========================================================

// POST /hooks/:endpointId - The "Magic URL"
fastify.post('/hooks/:endpointId', { config: { rawBody: true } }, async (request, reply) => {
  const { endpointId } = request.params as any;
  const payload = request.body;
  const headers = request.headers;

  // ============================================================
  // ⚡ OPTIMIZATION 1: Cache the Endpoint Lookup (Read)
  // ============================================================
  const cacheKey = `endpoint:${endpointId}:config`;

  // 1. Try to get from Redis
  let endpointConfig = await redisClient.get(cacheKey);
  let endpoint;

  if (endpointConfig) {
    // HIT: Parse JSON from cache
    endpoint = JSON.parse(endpointConfig);
  } else {
    // MISS: Fetch from DB
    endpoint = await prisma.endpoint.findUnique({
      where: { id: endpointId },
      select: { id: true, isPaused: true }
    });

    if (!endpoint) return reply.status(404).send({ error: 'Endpoint not found' });

    // Save to Redis for 60 seconds (Short TTL ensures Pause button works relatively fast)
    await redisClient.set(cacheKey, JSON.stringify(endpoint), 'EX', 60);
  }

  try {
    const raw = request.rawBody || '';
    await ingestionService.ingest(endpointId, payload, headers, endpoint.isPaused, raw);
    return reply.status(200).send({ received: true });
  } catch (error) {
    request.log.error(error);
    return reply.status(400).send({ error: 'Ingestion failed' });
  }
});

// 2. NEW ROUTE: TOGGLE PAUSE (POST /endpoints/:id/toggle-pause)
fastify.post('/endpoints/:id/toggle-pause', { preHandler: [authenticate] }, async (request, reply) => {
  const { id } = request.params as any;
  const userId = request.user.userId;

  const endpoint = await prisma.endpoint.findFirst({ where: { id, userId } });
  if (!endpoint) return reply.status(404).send({ error: 'Endpoint not found' });

  const newPausedState = !endpoint.isPaused;

  // 1. Update Endpoint State
  await prisma.endpoint.update({
    where: { id },
    data: { isPaused: newPausedState }
  });

  // 2. IF RESUMING (Play clicked): Flush the buffer!
  let recoveredCount = 0;
  if (newPausedState === false) {
    // Find all 'PAUSED' events
    const pausedEvents = await prisma.webhookEvent.findMany({
      where: { endpointId: id, status: 'PAUSED' },
      select: { id: true }
    });

    if (pausedEvents.length > 0) {
      // Update DB to PENDING
      await prisma.webhookEvent.updateMany({
        where: { endpointId: id, status: 'PAUSED' },
        data: { status: 'PENDING' }
      });

      // Push to Queue
      const jobs = pausedEvents.map(evt => ({
        name: 'dispatch-webhook',
        data: { eventId: evt.id }
      }));
      await queue.addJobsBulk(jobs); // Use the bulk method we made earlier
      recoveredCount = pausedEvents.length;
    }
  }

  return {
    success: true,
    isPaused: newPausedState,
    flushedEvents: recoveredCount
  };
});

// GET /stats - Advanced Analytics
// fastify.get('/stats', { preHandler: [authenticate] }, async (request, reply) => {
//   const userId = request.user.userId;
//   const now = new Date();

//   // 1. Calculate "Start of Today" (00:00:00)
//   const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

//   // 2. Calculate "Start of 7 Days Ago"
//   const sevenDaysAgo = new Date();
//   sevenDaysAgo.setDate(now.getDate() - 6);
//   sevenDaysAgo.setHours(0, 0, 0, 0);

//   // =========================================================
//   // PARALLEL QUERIES (For Performance)
//   // =========================================================
//   const [
//     totalEventsAllTime,
//     eventsToday,
//     eventsByStatus,
//     eventsOverTime,
//     topEndpoints
//   ] = await Promise.all([
//     // A. Total Events (All Time)
//     prisma.webhookEvent.count({ where: { endpoint: { userId } } }),

//     // B. Events Today (Count)
//     prisma.webhookEvent.count({ 
//       where: { 
//         endpoint: { userId },
//         receivedAt: { gte: startOfToday }
//       } 
//     }),

//     // C. Status Breakdown (For Success Ratio)
//     prisma.webhookEvent.groupBy({
//       by: ['status'],
//       where: { endpoint: { userId } },
//       _count: { id: true }
//     }),

//     // D. Time Series (Last 7 Days) - Requires Raw Query for simple aggregation in standard SQL
//     // Note: For Prisma, we often do this in JS if data is small, or raw query. 
//     // Here is a JS-aggregation approach which is safer for DB abstraction:
//     prisma.webhookEvent.findMany({
//       where: { 
//         endpoint: { userId },
//         receivedAt: { gte: sevenDaysAgo }
//       },
//       select: { receivedAt: true, status: true }
//     }),

//     // E. Top Endpoints by Volume
//     prisma.webhookEvent.groupBy({
//       by: ['endpointId'],
//       where: { endpoint: { userId } },
//       _count: { id: true },
//       orderBy: { _count: { id: 'desc' } },
//       take: 5
//     })
//   ]);

//   // =========================================================
//   // DATA PROCESSING
//   // =========================================================

//   // 1. Calculate Status Counts
//   const successCount = eventsByStatus.find(s => s.status === 'COMPLETED')?._count.id || 0;
//   const failCount = eventsByStatus.find(s => s.status === 'FAILED')?._count.id || 0;
//   const pendingCount = eventsByStatus.find(s => ['PENDING', 'PROCESSING', 'QUEUED'].includes(s.status))?._count.id || 0;

//   // 2. Success Ratio
//   const totalFinished = successCount + failCount;
//   const successRatio = totalFinished > 0 ? ((successCount / totalFinished) * 100).toFixed(1) : 0;

//   // 3. Process Time Series (Group by Date)
//   const daysMap = new Map<string, { date: string, success: number, failed: number }>();

//   // Initialize last 7 days with 0
//   for (let i = 0; i < 7; i++) {
//     const d = new Date();
//     d.setDate(now.getDate() - i);
//     const key = d.toISOString().split('T')[0]; // YYYY-MM-DD
//     daysMap.set(key, { date: key, success: 0, failed: 0 });
//   }

//   // Fill actual data
//   eventsOverTime.forEach(evt => {
//     const key = evt.receivedAt.toISOString().split('T')[0];
//     if (daysMap.has(key)) {
//       const entry = daysMap.get(key)!;
//       if (evt.status === 'COMPLETED') entry.success++;
//       else if (evt.status === 'FAILED') entry.failed++;
//     }
//   });

//   // Convert map to sorted array
//   const graphData = Array.from(daysMap.values()).sort((a, b) => a.date.localeCompare(b.date));

//   // 4. Resolve Endpoint Names for "Top Endpoints"
//   // (We only have IDs from the groupBy, need names)
//   const endpointIds = topEndpoints.map(e => e.endpointId);
//   const endpointDetails = await prisma.endpoint.findMany({
//     where: { id: { in: endpointIds } },
//     select: { id: true, name: true }
//   });

//   const endpointStats = topEndpoints.map(item => {
//     const details = endpointDetails.find(d => d.id === item.endpointId);
//     return {
//       name: details?.name || 'Unknown',
//       count: item._count.id
//     };
//   });

//   return {
//     kpi: {
//       totalAllTime: totalEventsAllTime,
//       totalToday: eventsToday,
//       successRatio: Number(successRatio),
//       activePending: pendingCount
//     },
//     graph: graphData, // [{ date: '2023-10-01', success: 10, failed: 2 }]
//     topEndpoints: endpointStats
//   };
// });

// GET /stats - Advanced Analytics (With Archiving Support)
fastify.get('/stats', { preHandler: [authenticate] }, async (request, reply) => {
  const userId = request.user.userId;
  const now = new Date();

  // 1. Calculate "Start of Today" (00:00:00)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // 2. Calculate "Start of 7 Days Ago"
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(now.getDate() - 6);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  // =========================================================
  // PARALLEL QUERIES (For Performance)
  // =========================================================
  const [
    liveTotalEvents,    // Renamed for clarity
    eventsToday,
    eventsByStatus,
    eventsOverTime,
    topEndpoints,
    archivedData        // 👈 NEW: Fetch the historical Deleted counts
  ] = await Promise.all([
    // A. Total LIVE Events
    prisma.webhookEvent.count({ where: { endpoint: { userId } } }),

    // B. Events Today (Count)
    prisma.webhookEvent.count({
      where: {
        endpoint: { userId },
        receivedAt: { gte: startOfToday }
      }
    }),

    // C. Status Breakdown (For Success Ratio)
    prisma.webhookEvent.groupBy({
      by: ['status'],
      where: { endpoint: { userId } },
      _count: { id: true }
    }),

    // D. Time Series (Last 7 Days)
    prisma.webhookEvent.findMany({
      where: {
        endpoint: { userId },
        receivedAt: { gte: sevenDaysAgo }
      },
      select: { receivedAt: true, status: true }
    }),

    // E. Top Endpoints by Volume (Live Data)
    prisma.webhookEvent.groupBy({
      by: ['endpointId'],
      where: { endpoint: { userId } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5
    }),

    // F. 👇 NEW QUERY: Sum of archived events
    prisma.endpoint.aggregate({
      where: { userId },
      _sum: { archivedSuccessCount: true }
    })
  ]);

  // =========================================================
  // DATA PROCESSING
  // =========================================================

  // 1. Calculate Historical Context
  const archivedCount = archivedData._sum.archivedSuccessCount || 0;

  // 2. Calculate Status Counts (Live)
  const liveSuccess = eventsByStatus.find(s => s.status === 'COMPLETED')?._count.id || 0;
  const liveFailed = eventsByStatus.find(s => s.status === 'FAILED')?._count.id || 0;

  // 3. 👇 MERGE: Total = Live Events + Archived Events
  const totalAllTime = liveTotalEvents + archivedCount;

  // 4. 👇 MERGE: Success Ratio Calculation
  // We add archivedCount to success because we only archive successful events
  const totalSuccess = liveSuccess + archivedCount;
  const totalFinished = totalSuccess + liveFailed;

  const successRatio = totalFinished > 0
    ? ((totalSuccess / totalFinished) * 100).toFixed(1)
    : 0;

  // 5. Calculate Pending (Active)
  const pendingCount = eventsByStatus.find(s => ['PENDING', 'PROCESSING', 'QUEUED'].includes(s.status))?._count.id || 0;

  // 6. Process Time Series (Group by Date)
  // (We don't add archived data here because graphs usually show recent activity, 
  // and archived data is by definition old (>7 days))
  const daysMap = new Map<string, { date: string, success: number, failed: number }>();

  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(now.getDate() - i);
    const key = d.toISOString().split('T')[0];
    daysMap.set(key, { date: key, success: 0, failed: 0 });
  }

  eventsOverTime.forEach(evt => {
    const key = evt.receivedAt.toISOString().split('T')[0];
    if (daysMap.has(key)) {
      const entry = daysMap.get(key)!;
      if (evt.status === 'COMPLETED') entry.success++;
      else if (evt.status === 'FAILED') entry.failed++;
    }
  });

  const graphData = Array.from(daysMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // 7. Resolve Endpoint Names for "Top Endpoints"
  const endpointIds = topEndpoints.map(e => e.endpointId);
  const endpointDetails = await prisma.endpoint.findMany({
    where: { id: { in: endpointIds } },
    select: { id: true, name: true }
  });

  const endpointStats = topEndpoints.map(item => {
    const details = endpointDetails.find(d => d.id === item.endpointId);
    return {
      name: details?.name || 'Unknown',
      count: item._count.id // Note: This shows live volume. Adding archived volume per-endpoint would require a separate query, which is usually overkill for a "Recent Top" list.
    };
  });

  return {
    kpi: {
      totalAllTime: totalAllTime, // Includes Deleted Events
      totalToday: eventsToday,
      successRatio: Number(successRatio), // Adjusted for Deleted Events
      activePending: pendingCount,
      // You can also pass the split if you want to show it in UI
      // archivedCount: archivedCount 
    },
    graph: graphData,
    topEndpoints: endpointStats
  };
});

// src/api/server.ts

// GET /events - Global Event Search & Filter
fastify.get('/events', { preHandler: [authenticate] }, async (request, reply) => {
  const {
    page = 1,
    limit = 20,
    status,
    endpointId,
    timeRange // '1h', '24h', '7d'
  } = request.query as any;

  const userId = request.user.userId;
  const skip = (Number(page) - 1) * Number(limit);

  // 1. Build Dynamic Where Clause
  const where: any = {
    endpoint: { userId } // Security: Only show my events
  };

  if (status && status !== 'ALL') {
    where.status = status;
  }

  if (endpointId && endpointId !== 'ALL') {
    where.endpointId = endpointId;
  }

  if (timeRange) {
    const now = new Date();
    let past = new Date();

    switch (timeRange) {
      case '1h': past.setHours(now.getHours() - 1); break;
      case '24h': past.setHours(now.getHours() - 24); break;
      case '7d': past.setDate(now.getDate() - 7); break;
      case '30d': past.setDate(now.getDate() - 30); break;
    }

    where.receivedAt = { gte: past };
  }

  // 2. Fetch Data + Count (Transaction for consistency)
  const [total, events] = await prisma.$transaction([
    prisma.webhookEvent.count({ where }),
    prisma.webhookEvent.findMany({
      where,
      include: { endpoint: true, attempts: true },
      orderBy: { receivedAt: 'desc' },
      skip,
      take: Number(limit)
    })
  ]);

  return {
    data: events,
    meta: {
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / Number(limit))
    }
  };
});

// PUT /endpoints/:id - Edit an Endpoint
fastify.put('/endpoints/:id', { preHandler: [authenticate] }, async (request, reply) => {
  const { id } = request.params as any;
  const data = request.body as any;

  // Security: Ensure user owns this endpoint
  const existing = await prisma.endpoint.findFirst({
    where: { id, userId: request.user.userId }
  });

  if (!existing) return reply.status(404).send({ error: 'Endpoint not found' });

  const updated = await prisma.endpoint.update({
    where: { id },
    data: {
      name: data.name,
      targetUrl: data.targetUrl,
      provider: data.provider,
      rateLimit: Number(data.rateLimit),
      secret: data.secret // Optional update
    }
  });

  return updated;
});

// POST /endpoints/:id/recover - Bulk Replay Failed Events
fastify.post('/endpoints/:id/recover', { preHandler: [authenticate] }, async (request, reply) => {
  const { id } = request.params as any;
  const userId = request.user.userId;

  // 1. Verify Ownership
  const endpoint = await prisma.endpoint.findFirst({
    where: { id, userId }
  });

  if (!endpoint) return reply.status(404).send({ error: 'Endpoint not found' });

  // 2. Find all FAILED events for this endpoint
  const failedEvents = await prisma.webhookEvent.findMany({
    where: {
      endpointId: id,
      status: 'FAILED'
    },
    select: { id: true } // We only need IDs
  });

  if (failedEvents.length === 0) {
    return { message: 'No failed events to recover', count: 0 };
  }

  // 3. Update DB Status to PENDING (Batch Update)
  await prisma.webhookEvent.updateMany({
    where: {
      endpointId: id,
      status: 'FAILED'
    },
    data: { status: 'PENDING' }
  });

  // 4. Push to Queue (Bulk)
  const jobs = failedEvents.map(evt => ({
    name: 'dispatch-webhook',
    data: { eventId: evt.id }
  }));

  await queue.addJobsBulk(jobs);

  request.log.info(`Recovered ${failedEvents.length} events for endpoint ${id}`);

  return {
    success: true,
    message: `Queued ${failedEvents.length} events for retry`,
    count: failedEvents.length
  };
});

// DELETE endpoint
fastify.delete('/endpoints/:id', { preHandler: [authenticate] }, async (request, reply) => {
  const { id } = request.params as any;
  const userId = request.user.userId;

  // 1. Verify Ownership
  const endpoint = await prisma.endpoint.findFirst({ where: { id, userId } });
  if (!endpoint) return reply.status(404).send({ error: 'Not found' });

  // 2. Delete Parent (Database automatically deletes all events & attempts)
  await prisma.endpoint.delete({ where: { id } });

  return { success: true };
});

// =========================================================
//  SERVER START
// =========================================================

const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
    console.log('🚀 Server running on http://localhost:3000');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();