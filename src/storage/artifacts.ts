import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { Artifact } from '../types.js';

export const MAX_ARTIFACT_BYTES = 5_000_000;

/**
 * Publication deliberately accepts one top-level file. The supervisor owns the
 * workspace's parent directories; worker-controlled intermediate paths are not
 * traversed. This is not a boundary against an uncontained same-user process.
 */
export function readWorkspaceArtifact(workspace: string, requestedPath: string): Buffer {
  let fd: number | undefined;
  try {
    const nominal = resolve(workspace), requested = resolve(nominal, requestedPath);
    const root = resolve(realpathSync(dirname(nominal)), basename(nominal));
    if (realpathSync(nominal) !== root || dirname(requested) !== nominal ||
        requestedPath.includes('\0') || basename(requested) === '.mcp.json') throw new Error('Invalid source path.');
    const path = resolve(root, basename(requested));
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_ARTIFACT_BYTES) throw new Error('Invalid source file.');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.nlink !== 1 ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Source changed during publication.');
    return buffer.subarray(0, length);
  } catch (cause) {
    throw new Error('Artifact must be a single-link regular file of at most 5 MB directly inside your workspace. Copy nested outputs to the workspace root before publishing; symlinks and changing files are rejected.', { cause });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

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
