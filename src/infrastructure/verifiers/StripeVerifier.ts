import crypto from 'crypto';
import { IVerifier } from '../../core/interfaces/IVerifier';

export class StripeVerifier implements IVerifier {
  verify(payload: any, headers: any, secret: string, rawBody: string | Buffer): boolean {
    const signatureHeader = headers['stripe-signature'];
    
    if (!signatureHeader || typeof signatureHeader !== 'string') {
      return false; // Header missing
    }

    // Stripe format: "t=123456789,v1=abcdef..."
    const parts = signatureHeader.split(',');
    const timestampPart = parts.find(p => p.startsWith('t='));
    const signaturePart = parts.find(p => p.startsWith('v1='));

    if (!timestampPart || !signaturePart) {
      return false; // Malformed header
    }

    const timestamp = timestampPart.split('=')[1];
    const signature = signaturePart.split('=')[1];

    // 1. Define Tolerance (e.g., 5 minutes = 300 seconds)
    const TOLERANCE = 300; 
    const now = Math.floor(Date.now() / 1000);

    const timestampTol = parseInt(timestampPart.split('=')[1], 10);

    // 2. Reject if too old
    if (now - timestampTol > TOLERANCE) {
      console.warn('[Security] Webhook timestamp too old - possible Replay Attack');
      return false;
}

    // Protection against Replay Attacks (Reject if older than 5 mins)
    // Optional but recommended:
    // const now = Math.floor(Date.now() / 1000);
    // if (now - parseInt(timestamp) > 300) return false;

    // Create the signed payload string exactly as Stripe does:
    // {timestamp}.{raw_body_content}
    const signedPayload = `${timestamp}.${rawBody.toString()}`;

    // Calculate HMAC
    const hmac = crypto.createHmac('sha256', secret);
    const calculatedSignature = hmac.update(signedPayload).digest('hex');

    // Use timingSafeEqual to prevent timing attacks
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(calculatedSignature)
      );
    } catch (e) {
      return false; // Length mismatch or other crypto error
    }
  }
}