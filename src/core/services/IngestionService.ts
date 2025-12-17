import { PrismaClient } from '@prisma/client';
import { QueueService } from '../../infrastructure/queue/QueueService';
import { VerifierFactory } from '../../infrastructure/verifiers/VerifierFactory';


export class IngestionService {
  constructor(
    private prisma: PrismaClient,
    private queue: QueueService
  ) {}

  // 👇 CHANGED: Added 'rawBody' parameter
  async ingest(endpointId: string, payload: any, headers: any, isPaused: boolean, rawBody: string | Buffer) {
    const initialStatus = isPaused ? 'PAUSED' : 'PENDING';
    
    // 1. Fetch Endpoint Config
    // Optimization: In production, verify against Redis cache first before hitting DB
    const endpoint = await this.prisma.endpoint.findUnique({ where: { id: endpointId } });
    
    if (!endpoint || !endpoint.isActive) {
      throw new Error('Endpoint not found or inactive');
    }

    // 2. Verify Signature (Security)
    if (endpoint.secret && endpoint.provider !== 'generic') {
      const verifier = VerifierFactory.getVerifier(endpoint.provider);
      
      // We pass the rawBody here because crypto needs exact byte matching
      const isValid = verifier.verify(payload, headers, endpoint.secret, rawBody);
      
      if (!isValid) {
        console.warn(`[Security] Signature mismatch for endpoint ${endpointId}`);
        throw new Error('Invalid Signature');
      }
    }

    // 3. Persist Event (Database)
    const event = await this.prisma.webhookEvent.create({
      data: {
        endpointId: endpoint.id,
        payload: payload, // Stores the usable JSON
        headers: headers,
        status: initialStatus
      }
    });

    // 4. Push to Buffer (Redis)
    if (!isPaused) {
      await this.queue.addJob('dispatch-webhook', { eventId: event.id });
    } else {
      console.log(`⏸️ Event ${event.id} buffered (Endpoint Paused).`);
    }

    return { success: true, eventId: event.id };
  }
}