import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync, existsSync } from 'node:fs';

async function main() {
  const configurations: Record<string, { type?: string; url?: string; headers?: Record<string, string> }> = {};
  for (const path of ['/home/agent/.claude.json', '/home/agent/.mcp.json', '/home/agent/workspace/.mcp.json']) {
    if (!existsSync(path)) continue;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    Object.assign(configurations, value.mcpServers ?? {});
    Object.assign(configurations, value.projects?.['/home/agent/workspace']?.mcpServers ?? {});
  }
  // Never return credentials, query strings or configuration bodies to the host report.
  const report: Record<string, unknown> = { configuredServers: Object.keys(configurations),
    gatewayEnvironmentPresent: Boolean(process.env.MCP_GATEWAY_URL) };
  const endpoints = [
    ...Object.entries(configurations).filter(([, c]) => c.url).map(([name, c]) => ({ name, url: c.url!, headers: c.headers })),
    ...(process.env.MCP_GATEWAY_URL ? [{ name: 'ambient-gateway', url: process.env.MCP_GATEWAY_URL, headers: undefined }] : []),
  ];
  const observations = [];
  for (const endpoint of endpoints) {
    const url = new URL(endpoint.url);
    const client = new Client({ name: 'collective-scope-rehearsal', version: '1.0.0' });
    const observation: Record<string, unknown> = { name: endpoint.name, endpoint: url.origin + url.pathname };
    try {
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: endpoint.headers } }), { timeout: 5000 });
      const inventory = await client.listTools(undefined, { timeout: 5000 });
      observation.tools = inventory.tools.map(t => ({ name: t.name, inputSchema: t.inputSchema }));
      const allowed = inventory.tools.find(t => t.name.endsWith('allowed_add') && !t.name.endsWith('unlisted_allowed_add'));
      if (allowed) observation.allowedResult = await client.callTool({ name: allowed.name, arguments: { a: 2, b: 3 } }, undefined, { timeout: 5000 });
      const deniedCalls = [];
      for (const call of [
        { name: 'unlisted_add', arguments: { a: 2, b: 3 } },
        { name: 'mcp-exec', arguments: { name: 'unlisted_add', arguments: { a: 2, b: 3 } } },
        { name: 'code-mode', arguments: { tools: ['unlisted_add'] } },
      ]) {
        try { deniedCalls.push({ method: call.name, result: await client.callTool(call, undefined, { timeout: 5000 }) }); }
        catch (error) { deniedCalls.push({ method: call.name, rejected: true, error: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown error' }); }
      }
      observation.unlistedAttempts = deniedCalls;
    } catch (error) { observation.error = error instanceof Error ? error.message.slice(0, 1000) : 'Unknown transport error'; }
    finally { await client.close().catch(() => {}); }
    observations.push(observation);
  }
  report.observations = observations;
  console.log('COLLECTIVE_MCP_SCOPE_V1 ' + JSON.stringify(report));
}
main().catch(() => { console.error('MCP fixture failed'); process.exitCode = 1; });
