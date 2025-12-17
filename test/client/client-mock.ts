// tests/client-mock.ts
import Fastify from 'fastify';

const fastify = Fastify({ logger: false });
const PORT = 4000;

// Simulation Config
const CRASH_RATE = 0.3; // 30% chance to crash (return 500)
const PROCESS_DELAY = 500; // Takes 500ms to process a "heavy" order
//https://ideal-barnacle-46qqqqvp9p6c74w-4000.app.github.dev/webhooks/payment
fastify.post('/webhooks/payment', async (request, reply) => {
  const body = request.body as any;
  const reqId = body.id;

  console.log(`[Client] 📩 Received Request #${reqId} at ${new Date().toISOString()}`);

  // 1. Simulate "Chaos" (Random Server Failure)
  if (Math.random() < CRASH_RATE) {
    console.log(`[Client] 💥 CRASHED on Request #${reqId} (Simulated 500 Error)`);
    return reply.status(500).send({ error: 'Database Connection Failed' });
  }

  // 2. Simulate "Heavy Load" (Traffic Smoothing Check)
  // If your SaaS works, these logs should appear roughly every 1 second (per rate limit),
  // instead of 50 logs appearing instantly.
  await new Promise(resolve => setTimeout(resolve, PROCESS_DELAY));

  console.log(`[Client] ✅ Processed Request #${reqId}`);
  return reply.status(200).send({ status: 'Order Created' });
});

const start = async () => {
  try {
    await fastify.listen({ port: PORT });
    console.log(`💀 Victim Server running on http://localhost:${PORT}`);
    console.log(`   - Crash Rate: ${CRASH_RATE * 100}%`);
    console.log(`   - Processing Time: ${PROCESS_DELAY}ms`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();