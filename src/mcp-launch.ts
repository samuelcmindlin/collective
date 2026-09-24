import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { z } from 'zod/v3';

const launchSchema = z.object({
  endpoint: z.string().refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port)
        && url.pathname === '/agent/tools' && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }, 'The domain bridge requires the supervisor loopback tool endpoint.'),
  token: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type McpLaunch = z.infer<typeof launchSchema>;

/** Host-only configuration. Never copy this file or its token into a worker VM. */
export function readMcpLaunch(path: string): McpLaunch {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 4096 || (before.mode & 0o077)
      || (process.getuid && before.uid !== process.getuid())) throw new Error('Unsafe MCP launch file.');
    const buffer = Buffer.alloc(4097);
    const bytes = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0));
    const after = fstatSync(fd);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) throw new Error('MCP launch file changed while reading.');
    return launchSchema.parse(JSON.parse(bytes.toString('utf8')));
  } finally { closeSync(fd); }
}

export function environmentMcpLaunch(endpoint: string | undefined, token: string | undefined): McpLaunch {
  return launchSchema.parse({ endpoint, token });
}
