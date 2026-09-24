import { z } from 'zod/v3';
import type { Config } from './config.js';
import type { PermissionRequest } from './types.js';

export async function githubAction(config: Config, request: PermissionRequest) {
  if (!config.githubToken || !config.githubOwner) throw new Error('GitHub is not configured. Add a scoped GITHUB_TOKEN and GITHUB_OWNER to .env.');
  const api = async (path: string, method = 'GET', body?: unknown, allow404 = false): Promise<any> => {
    const response = await fetch(`https://api.github.com${path}`, { method, headers: { Authorization: `Bearer ${config.githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    if (response.status === 404 && allow404) return undefined;
    const result = await response.json() as any;
    if (!response.ok) throw new Error(`GitHub returned ${response.status}: ${String(result.message ?? 'request failed').slice(0, 300)}`);
    return result;
  };
  const owner = encodeURIComponent(config.githubOwner);
  if (request.capability === 'github.create_repo') {
    const scope = z.object({ name: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/), description: z.string().max(250), visibility: z.literal('private') }).strict().parse(request.scope);
    const marker = `Collective request ${request.id}`;
    const existing = await api(`/repos/${owner}/${encodeURIComponent(scope.name)}`, 'GET', undefined, true);
    if (existing) { if (!existing.private || !String(existing.description).includes(marker)) throw new Error('A repository with this name already exists and is not owned by this request.'); return { url: existing.html_url, repository: existing.full_name }; }
    const me = await api('/user');
    const repo = await api(me.login.toLowerCase() === config.githubOwner.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`, 'POST', { name: scope.name, description: `${scope.description} · ${marker}`, private: true, auto_init: true });
    return { url: repo.html_url, repository: repo.full_name };
  }
  const scope = z.object({ repository: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/), head: z.string().regex(/^[a-zA-Z0-9_./-]{1,150}$/), base: z.string().regex(/^[a-zA-Z0-9_./-]{1,150}$/), title: z.string().min(1).max(200), body: z.string().max(20000) }).strict().parse(request.scope);
  const repoPath = `/repos/${owner}/${encodeURIComponent(scope.repository)}`;
  const repo = await api(repoPath);
  if (!repo.private) throw new Error('Initial GitHub policy allows private repositories only.');
  const marker = `<!-- collective-request:${request.id} -->`;
  const existing = await api(`${repoPath}/pulls?state=all&head=${encodeURIComponent(`${config.githubOwner}:${scope.head}`)}&base=${encodeURIComponent(scope.base)}`);
  const match = existing.find((pr: any) => String(pr.body).includes(marker));
  if (match) return { url: match.html_url, number: match.number };
  const pr = await api(`${repoPath}/pulls`, 'POST', { title: scope.title, head: scope.head, base: scope.base, body: `${scope.body}\n\n${marker}`, draft: true });
  return { url: pr.html_url, number: pr.number };
}
