import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod/v3';

async function main() {
  const input = z.array(z.object({ name: z.string(), arguments: z.record(z.unknown()) }).strict()).min(1).max(8)
    .parse(JSON.parse(readFileSync('/home/agent/workspace/domain-input.json', 'utf8')));
  const endpoint = process.env.MCP_GATEWAY_URL;
  if (!endpoint) throw new Error('Expected the sandbox local MCP gateway.');
  const client = new Client({ name: 'collective-domain-rehearsal', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)), { timeout: 5000 });
    const tools = await client.listTools(undefined, { timeout: 5000 });
    const results = [];
    for (const operation of input) {
      const matches = tools.tools.filter(t => t.name === operation.name || t.name.endsWith(`_${operation.name}`));
      if (matches.length !== 1) throw new Error('Missing or ambiguous domain tool.');
      const result = await client.callTool({ name: matches[0]!.name, arguments: operation.arguments }, undefined, { timeout: 5000 });
      results.push({ name: operation.name, isError: result.isError === true, content: result.content });
    }
    console.log('COLLECTIVE_DOMAIN_V1 ' + JSON.stringify({ version: 1, results }));
  } finally { await client.close(); }
}
main().catch(() => { console.error('Domain bridge fixture failed.'); process.exitCode = 1; });
