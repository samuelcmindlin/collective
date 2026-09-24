import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 0 && c === 2))) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113));
  }
  // Only globally routed IPv6; exclude documentation and transition mechanisms.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0|10|20):/i.test(address) && !/^2002:/i.test(address);
}
export async function readPublicPage(input: string, redirects = 0): Promise<{ url: string; content: string; untrusted: true }> {
  if (redirects > 3) throw new Error('Too many redirects.');
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Only public HTTPS pages on port 443 are allowed.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Private and special-purpose network addresses are not allowed.');
  // Pin the validated DNS result in the actual connection to prevent DNS rebinding.
  const address = addresses[0]!;
  const result = await new Promise<{ status: number; location?: string; contentType: string; body: string }>((resolve, reject) => {
    const req = request(url, { method: 'GET', headers: { 'User-Agent': 'CollectiveResearch/0.1', Accept: 'text/html,text/plain,application/json' }, lookup: ((_host: string, options: any, callback: any) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family)) as any }, res => {
      const chunks: Buffer[] = []; let length = 0;
      res.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 1_000_000) req.destroy(new Error('Page exceeds the 1 MB read limit.')); else chunks.push(chunk); });
      res.on('end', () => resolve({ status: res.statusCode ?? 500, location: res.headers.location, contentType: res.headers['content-type'] ?? '', body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(15000, () => req.destroy(new Error('Page read timed out.'))); req.on('error', reject); req.end();
  });
  if (result.status >= 300 && result.status < 400 && result.location) return readPublicPage(new URL(result.location, url).href, redirects + 1);
  if (result.status < 200 || result.status >= 300) throw new Error(`Page returned HTTP ${result.status}.`);
  if (!/text\/|application\/json/i.test(result.contentType)) throw new Error('This reader supports text, HTML, and JSON pages.');
  const content = result.body.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim().slice(0, 40000);
  return { url: url.href, content, untrusted: true };
}
