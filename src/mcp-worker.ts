import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { toolSchemas, toolDescriptions, type ToolName } from './service.js';
import { callAgentTool } from './agent-client.js';

const endpoint = process.env.COLLECTIVE_AGENT_ENDPOINT;
const token = process.env.COLLECTIVE_RUN_TOKEN;
if (!endpoint || !token) throw new Error('This MCP worker must be launched by the Collective supervisor.');
const server = new McpServer({ name: 'collective', version: '0.1.0' });
for (const [name, schema] of Object.entries(toolSchemas)) {
  server.registerTool(name, { description: toolDescriptions[name as ToolName], inputSchema: schema.shape }, async (args: Record<string, unknown>) => {
    try {
      const result = await callAgentTool(endpoint, token, name, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.value) }], isError: result.isError };
    } catch (error) { return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
  });
}
await server.connect(new StdioServerTransport());
