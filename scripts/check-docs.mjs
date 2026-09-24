import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v3';

// This checks a maintainer-authored manifest; it does not import knowledge or
// establish runtime trust. Source authorization belongs to the future importer.
const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const slug = z.string().regex(/^[a-z][a-z0-9-]*$/);
const documentSchema = z.object({
  id: z.string().regex(/^(platform|operator)\.[a-z0-9-]+$/),
  path: z.string().min(1),
  namespace: z.enum(['platform', 'operator']),
  kind: z.enum(['index', 'assessment', 'research', 'design', 'plan', 'description', 'runbook', 'decision-record']),
  owner: z.literal('maintainer'),
  status: z.enum(['recorded', 'proposed', 'accepted', 'superseded', 'archived']),
  audience: z.array(z.enum(['operator', 'developer', 'agent'])).min(1),
  importMode: z.literal('read-only'),
  tags: z.array(slug).min(1),
}).strict();
const catalogSchema = z.object({
  version: z.literal(1),
  documents: z.array(documentSchema).min(1),
}).strict();

const errors = [];
function confined(target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolveFile(relative, label) {
  try {
    const candidate = path.resolve(root, relative);
    if (!confined(candidate)) throw new Error('path escapes project root');
    const canonical = await realpath(candidate);
    if (!confined(canonical)) throw new Error('symlink escapes project root');
    if (!(await stat(canonical)).isFile()) throw new Error('not a file');
    return canonical;
  } catch (error) {
    errors.push(`${label}: ${error.message}`);
    return null;
  }
}

async function markdownPaths(directory) {
  const paths = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await markdownPaths(relative));
    else if (entry.name.endsWith('.md')) paths.push(relative);
  }
  return paths;
}

try {
  const catalog = catalogSchema.parse(JSON.parse(await readFile(path.join(root, 'docs/catalog.json'), 'utf8')));
  const ids = new Set();
  const registeredPaths = new Set();
  const canonicalPaths = new Set();
  let localLinks = 0;

  for (const document of catalog.documents) {
    if (ids.has(document.id)) errors.push(`duplicate ID: ${document.id}`);
    ids.add(document.id);
    if (!document.id.startsWith(`${document.namespace}.`)) errors.push(`${document.id}: namespace mismatch`);
    if (new Set(document.audience).size !== document.audience.length) errors.push(`${document.id}: duplicate audience`);
    if (new Set(document.tags).size !== document.tags.length) errors.push(`${document.id}: duplicate tag`);
    if (path.isAbsolute(document.path) || document.path.includes('\\') || document.path.split('/').some(part => part === '..' || part === '.' || !part)) {
      errors.push(`${document.id}: source must be a normalized relative path`);
      continue;
    }
    if (!document.path.endsWith('.md')) errors.push(`${document.id}: source must be Markdown`);
    if (registeredPaths.has(document.path)) errors.push(`duplicate path: ${document.path}`);
    registeredPaths.add(document.path);
    const source = await resolveFile(document.path, document.id);
    if (!source) continue;
    if (canonicalPaths.has(source)) errors.push(`${document.id}: duplicate canonical source`);
    canonicalPaths.add(source);
    const markdown = await readFile(source, 'utf8');
    if (!/^# \S/m.test(markdown)) errors.push(`${document.id}: missing level-one title`);

    // Validate inline local link targets. Fragment anchors and remote links are
    // deliberately outside this lightweight check; code examples are excluded.
    const prose = markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
    for (const match of prose.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
      const href = match[1].trim().replace(/^<([^>]+)>$/, '$1');
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue;
      const target = decodeURIComponent(href.split(/[?#]/)[0]);
      if (!target) continue;
      localLinks++;
      if (path.isAbsolute(target)) {
        errors.push(`${document.path}: use a relative local link: ${href}`);
        continue;
      }
      await resolveFile(path.relative(root, path.resolve(path.dirname(source), target)), `${document.path} -> ${href}`);
    }
  }

  const expectedPaths = ['README.md', ...await markdownPaths('docs')];
  for (const expected of expectedPaths) {
    if (!registeredPaths.has(expected)) errors.push(`uncatalogued document: ${expected}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Documentation valid: ${catalog.documents.length} documents, unique IDs/sources, complete coverage, ${localLinks} local links.`);
} catch (error) {
  console.error(`Documentation check failed:\n${error.message}`);
  process.exitCode = 1;
}
