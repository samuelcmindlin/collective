import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashRecord } from '../src/progress/checks.js';

/** Fingerprint source and fixtures without reading credentials or runtime data. */
export function scenarioSourceHash(root: string): string {
  const paths = ['package.json', 'package-lock.json', 'tsconfig.json'];
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:ts|mjs|json)$/.test(entry.name)) paths.push(path);
    }
  };
  visit('src'); visit('scripts');
  return hashRecord(paths.sort().map(path => [path, readFileSync(join(root, path), 'utf8')]));
}
