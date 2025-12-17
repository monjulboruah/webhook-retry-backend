// src/utils/urlValidator.ts
import dns from 'dns/promises';
import ipaddr from 'ipaddr.js';

export async function isSafeUrl(targetUrl: string): Promise<boolean> {
  try {
    const url = new URL(targetUrl);
    
    // 1. Block non-http protocols (e.g., file://, ftp://)
    if (!['http:', 'https:'].includes(url.protocol)) return false;

    // 2. Resolve Hostname to IP
    const { address } = await dns.lookup(url.hostname);

    // 3. Check if IP is Private/Local
    const ip = ipaddr.parse(address);
    const range = ip.range();

    // Block these ranges
    const blockedRanges = [
      'unicast', // 10.x, 172.16.x, 192.168.x (Private LAN)
      'loopback', // 127.0.0.1 (Localhost)
      'linkLocal', // 169.254.x.x (AWS Metadata)
      'private',
      'carrierGradeNat'
    ];

    if (blockedRanges.includes(range)) {
      console.warn(`[Security] Blocked SSRF attempt to ${targetUrl} (${range})`);
      return false;
    }

    return true;
  } catch (error) {
    return false; // If URL is invalid, block it
  }
}