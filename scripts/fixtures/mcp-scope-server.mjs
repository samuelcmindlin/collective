// Maintainer-authored host fixture: one pure arithmetic tool, no filesystem/network actions.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v3';

const label = process.argv[2];
if (!['allowed', 'unlisted'].includes(label)) throw new Error('Expected a fixture label');
const server = new McpServer({ name: `collective-scope-${label}`, version: '1.0.0' });
server.registerTool(`${label}_add`, {
  description: `Synthetic ${label} arithmetic fixture; no side effects.`,
  inputSchema: { a: z.number().int().min(-100).max(100), b: z.number().int().min(-100).max(100) },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ a, b }) => ({ content: [{ type: 'text', text: JSON.stringify({ server: label, sum: a + b }) }] }));
await server.connect(new StdioServerTransport());
