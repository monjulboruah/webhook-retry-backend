// tests/stripe-mock.ts
import axios from 'axios';

// CONFIGURATION
const SAAS_URL = 'https://ideal-barnacle-46qqqqvp9p6c74w-3000.app.github.dev/hooks'; 
// ⚠️ REPLACE THIS ID with a real Endpoint ID from your Dashboard!
const ENDPOINT_ID = 'b69735eb-e6eb-4053-abae-37a4ce5d79f5'; 

const TOTAL_REQUESTS = 500;

async function runFlashSale() {
  console.log(`🚀 STARTING FLASH SALE: Sending ${TOTAL_REQUESTS} webhooks instantly...`);
  
  const promises = [];

  for (let i = 1; i <= TOTAL_REQUESTS; i++) {
    const payload = {
      id: i,
      type: 'payment_intent.succeeded',
      amount: Math.floor(Math.random() * 10000),
      currency: 'usd',
      created: Date.now()
    };

    // Fire and forget (Async)
    const req = axios.post(`${SAAS_URL}/${ENDPOINT_ID}`, payload)
      .then(() => process.stdout.write('.')) // Visual progress
      .catch(err => process.stdout.write('X'));

    promises.push(req);
  }

  await Promise.all(promises);
  console.log('\n\n✅ Stripe has finished sending all requests!');
}

runFlashSale();