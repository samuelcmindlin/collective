import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Artifact } from '../types.js';

export const MAX_ARTIFACT_BYTES = 5_000_000;

/** Return only bytes matching the published snapshot. This does not isolate workers. */
export function readArtifactSnapshot(dataDir: string, artifact: Artifact): Buffer {
  let fd: number | undefined;
  try {
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > MAX_ARTIFACT_BYTES) throw new Error('Invalid size.');
    const root = realpathSync(dataDir);
    const directory = resolve(root, 'artifacts');
    const path = resolve(root, artifact.path);
    if (dirname(path) !== directory || realpathSync(directory) !== directory) throw new Error('Invalid snapshot path.');
    // No-follow rejects a substituted leaf symlink; nonblocking avoids hanging on a FIFO.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== artifact.size) throw new Error('Snapshot size differs.');
    // Read at most one extra byte to detect growth without an unbounded allocation/read.
    const buffer = Buffer.alloc(artifact.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    if (length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Snapshot hash differs.');
    return bytes;
  } catch (cause) {
    throw new Error(`Artifact integrity check failed for ${artifact.id}. Restore the original snapshot or publish a new artifact.`, { cause });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
