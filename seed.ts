// seed.ts
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // 1. Create a Dummy User
  const user = await prisma.user.create({
    data: {
      email: 'demo1@example.com',
    }
  });

  // 2. Create an Endpoint (Where you send data -> Where it goes)
  const endpoint = await prisma.endpoint.create({
    data: {
      userId: user.id,
      name: 'Stripe Prod',
      provider: 'generic', // Skips signature check for testing
      targetUrl: 'https://webhook.site/dsdsdsfsf', // Replace with a real testing URL
      isActive: true
    }
  });

  console.log('✅ Seed Setup Complete!');
  console.log('🔑 YOUR ENDPOINT ID:', endpoint.id);
  console.log(`curl -X POST http://localhost:3000/hooks/${endpoint.id} -H "Content-Type: application/json" -d '{"data": "test"}'`);
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());

//   🔑 YOUR ENDPOINT ID: 61261cdf-eac8-43d8-afc4-7912c8d1fbba
// curl -X POST http://localhost:3000/hooks/61261cdf-eac8-43d8-afc4-7912c8d1fbba -H "Content-Type: application/json" -d '{"data": "test"}'