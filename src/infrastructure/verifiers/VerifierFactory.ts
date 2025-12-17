import { IVerifier } from '../../core/interfaces/IVerifier';
import { StripeVerifier } from './StripeVerifier';

// A simple "Null Object" verifier for Generic endpoints that always passes
class GenericVerifier implements IVerifier {
  verify() { return true; } 
}

export class VerifierFactory {
  static getVerifier(provider: string): IVerifier {
    switch (provider.toLowerCase()) {
      case 'stripe': 
        return new StripeVerifier();
      // case 'shopify': return new ShopifyVerifier();
      default: 
        return new GenericVerifier();
    }
  }
}