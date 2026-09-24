import { randomUUID } from 'node:crypto';
import { isTaskTool } from './application/tasks.js';

/** A lost HTTP reply may follow a successful commit. Task retries retain the ID. */
export async function callAgentTool(endpoint: string, token: string, name: string, args: Record<string, unknown>) {
  const retryable = isTaskTool(name);
  const commandId = retryable ? (typeof args.commandId === 'string' ? args.commandId.trim() : randomUUID()) : undefined;
  const body = JSON.stringify({ name, arguments: args, commandId });
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body, signal: AbortSignal.timeout(60000),
      });
      const value: unknown = await response.json();
      if (retryable && attempt === 0 && response.status >= 500) continue;
      return { value, isError: !response.ok };
    } catch (error) {
      if (!retryable || attempt > 0) throw error;
    }
  }
}
