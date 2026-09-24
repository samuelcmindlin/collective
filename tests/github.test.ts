import test from 'node:test';
import assert from 'node:assert/strict';
import { githubAction } from '../src/github.js';
import type { Config } from '../src/config.js';
import type { PermissionRequest } from '../src/types.js';

// Protocol tests only: fetch is replaced before every call; no credentials or
// real GitHub repositories are used. Domain approval tests live in core.test.ts.
const config: Config = {
  root: process.cwd(), dataDir: '/tmp/unused-github-protocol', port: 4399,
  mode: 'simulation', claudeBin: 'unused', operatorIds: [],
  githubOwner: 'collective-fixture', githubToken: 'fake-test-token',
};
function request(capability: PermissionRequest['capability'], scope: Record<string, unknown>): PermissionRequest {
  return {
    id: 'request-fixture', agentId: 'ember', title: 'Publish candidate', reason: 'Protocol fixture',
    capability, scope, alternatives: 'Keep local', estimatedCost: 0, status: 'approved',
    createdAt: '2026-09-23T12:00:00.000Z',
  };
}
const prScope = {
  repository: 'game', head: 'agents/ember/candidate-1', base: 'main',
  title: 'Add a playable round', body: 'Implements a round.\n\nValidation: local checks passed.',
};
type ExpectedCall = { path: string; method?: string; status?: number; result: unknown; body?: Record<string, unknown> };
async function withProtocol(calls: ExpectedCall[], action: () => Promise<unknown>) {
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = async (input, init) => {
    const expected = calls[index++];
    assert.ok(expected, `Unexpected request: ${String(input)}`);
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(url.pathname + url.search, expected.path);
    assert.equal(init?.method, expected.method ?? 'GET');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fake-test-token');
    if (expected.body) assert.deepEqual(JSON.parse(String(init?.body)), expected.body);
    return new Response(JSON.stringify(expected.result), { status: expected.status ?? 200 });
  };
  try {
    const result = await action();
    assert.equal(index, calls.length, 'all expected requests were issued');
    return result;
  } finally { globalThis.fetch = original; }
}
const repo = '/repos/collective-fixture/game';
const list = `${repo}/pulls?state=all&head=collective-fixture%3Aagents%2Fember%2Fcandidate-1&base=main`;

test('GitHub broker opens a draft PR from an already-existing remote branch', async () => {
  const result = await withProtocol([
    { path: repo, result: { private: true } },
    { path: list, result: [] },
    { path: `${repo}/pulls`, method: 'POST', status: 201,
      body: { title: prScope.title, head: prScope.head, base: prScope.base,
        body: `${prScope.body}\n\n<!-- collective-request:request-fixture -->`, draft: true },
      result: { html_url: 'https://github.com/collective-fixture/game/pull/1', number: 1 } },
  ], () => githubAction(config, request('github.create_pr', prScope)));
  assert.deepEqual(result, { url: 'https://github.com/collective-fixture/game/pull/1', number: 1 });
});

test('GitHub broker reconciles a prior PR using its request marker', async () => {
  const result = await withProtocol([
    { path: repo, result: { private: true } },
    { path: list, result: [{ body: '<!-- collective-request:request-fixture -->',
      html_url: 'https://github.com/collective-fixture/game/pull/7', number: 7 }] },
  ], () => githubAction(config, request('github.create_pr', prScope)));
  assert.deepEqual(result, { url: 'https://github.com/collective-fixture/game/pull/7', number: 7 });
});

test('GitHub broker rejects a public repository before creating a PR', async () => {
  await withProtocol([{ path: repo, result: { private: false } }], async () => {
    await assert.rejects(githubAction(config, request('github.create_pr', prScope)), /private repositories only/);
  });
});

test('GitHub validation failure does not pretend a missing branch was uploaded', async () => {
  await withProtocol([
    { path: repo, result: { private: true } }, { path: list, result: [] },
    { path: `${repo}/pulls`, method: 'POST', status: 422, result: { message: 'Head ref must be a branch' } },
  ], async () => {
    await assert.rejects(githubAction(config, request('github.create_pr', prScope)), /GitHub returned 422/);
  });
});

test('GitHub repository creation uses the configured user and private visibility', async () => {
  const result = await withProtocol([
    { path: repo, status: 404, result: { message: 'Not Found' } },
    { path: '/user', result: { login: 'collective-fixture' } },
    { path: '/user/repos', method: 'POST', status: 201,
      body: { name: 'game', description: 'Our game · Collective request request-fixture', private: true, auto_init: true },
      result: { html_url: 'https://github.com/collective-fixture/game', full_name: 'collective-fixture/game' } },
  ], () => githubAction(config, request('github.create_repo', { name: 'game', description: 'Our game', visibility: 'private' })));
  assert.deepEqual(result, { url: 'https://github.com/collective-fixture/game', repository: 'collective-fixture/game' });
});

test('GitHub configuration and scope failures issue no HTTP requests', async () => {
  await withProtocol([], async () => {
    await assert.rejects(githubAction({ ...config, githubToken: undefined }, request('github.create_pr', prScope)), /not configured/);
    await assert.rejects(githubAction(config, request('github.create_pr', { ...prScope, repository: '../outside' })));
  });
});
