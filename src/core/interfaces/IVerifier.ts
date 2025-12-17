export interface IVerifier {
  /**
   * Verifies the webhook signature.
   * @param payload - The parsed JSON body (for logic checks)
   * @param headers - The request headers containing the signature
   * @param secret - The signing secret stored in your Endpoint config
   * @param rawBody - The raw string/buffer of the request body (CRITICAL for crypto signatures)
   */
  verify(payload: any, headers: any, secret: string, rawBody: string | Buffer): boolean;
}