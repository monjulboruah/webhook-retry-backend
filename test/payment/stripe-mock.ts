// tests/stripe-mock.ts
import axios from 'axios';

// CONFIGURATION
const SAAS_URL = 'https://curly-fiesta-9496r4jrgphpqq5-3000.app.github.dev/hooks'; 
// ⚠️ REPLACE THIS ID with a real Endpoint ID from your Dashboard!
const ENDPOINT_ID = 'b9253eac-8b5b-4a29-b008-39eb5f2c0e52'; 
//https://curly-fiesta-9496r4jrgphpqq5-3000.app.github.dev/hooks/b9253eac-8b5b-4a29-b008-39eb5f2c0e52

//https://curly-fiesta-9496r4jrgphpqq5-3000.app.github.dev/hooks/b9253eac-8b5b-4a29-b008-39eb5f2c0e52

const TOTAL_REQUESTS = 100;

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