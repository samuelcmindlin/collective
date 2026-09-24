import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { toolSchemas, toolDescriptions, type ToolName } from './service.js';
import { callAgentTool } from './agent-client.js';
import { environmentMcpLaunch, readMcpLaunch } from './mcp-launch.js';

// A host gateway can launch this server with a private file, keeping credentials
// out of its registry/argv and out of the guest. Native launches retain env input.
const { endpoint, token } = process.argv.length === 4 && process.argv[2] === '--launch-file'
  ? readMcpLaunch(process.argv[3]!)
  : process.argv.length === 2
    ? environmentMcpLaunch(process.env.COLLECTIVE_AGENT_ENDPOINT, process.env.COLLECTIVE_RUN_TOKEN)
    : (() => { throw new Error('Expected --launch-file <host-private-file>.'); })();
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
