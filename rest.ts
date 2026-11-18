// The REST v3 surface: users, repositories, contents, git refs, branches, commits, labels,
// issues, comments and pull requests (including squash/merge with file-level conflict
// detection). The JSON shapers and the merge are shared with the GraphQL and MCP surfaces so
// every view of an object is the same object.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, guard, notFound, parseJsonBody, readBody, sendJson } from './http.ts';
import { store, type ItemRec, type RepoRec } from './store.ts';
import {
  buildTreeFromFiles,
  flattenCommit,
  flattenTree,
  identLine,
  mergeBase,
  parseCommit,
  parseTree,
  putObject,
  buildCommit,
  type FileEntry,
} from './gitobj.ts';

// ------------------------------------------------------------------ JSON shapes

export function userJson(login: string) {
  const user = store.userByLogin(login) ?? store.viewer;
  return {
    login: user.login,
    id: user.id,
    name: user.name,
    email: user.email,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: RepoRec) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    open_issues_count: repo.items.filter((item) => item.kind === 'issue' && item.state === 'open').length,
    created_at: store.iso(repo.seq),
    updated_at: store.iso(repo.seq),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://forge.invalid/${repo.owner}/${repo.name}.git`,
  };
}

export function labelJson(repo: RepoRec, name: string) {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
}

export function issueJson(repo: RepoRec, item: ItemRec) {
  const body: Record<string, unknown> = {
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels.map((name) => labelJson(repo, name)),
    user: userJson(item.author),
    comments: item.comments.length,
    created_at: store.iso(item.seq),
    updated_at: store.iso(item.seq),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${item.number}`,
  };
  if (item.kind === 'pr') {
    body.pull_request = { url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/pulls/${item.number}` };
  }
  return body;
}

export function commentJson(repo: RepoRec, item: ItemRec, comment: { id: number; body: string; author: string; seq: number }) {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.author),
    created_at: store.iso(comment.seq),
    updated_at: store.iso(comment.seq),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${item.number}#issuecomment-${comment.id}`,
  };
}

function refSide(repo: RepoRec, ref: string, storedSha: string) {
  const sha = repo.refs.get(`refs/heads/${ref}`) ?? storedSha;
  return { ref, sha, label: `${repo.owner}:${ref}` };
}

export function pullJson(repo: RepoRec, item: ItemRec) {
  return {
    id: item.id,
    number: item.number,
    state: item.state,
    title: item.title,
    body: item.body,
    user: userJson(item.author),
    head: refSide(repo, item.headRef, item.headSha),
    base: refSide(repo, item.baseRef, item.baseSha),
    merged: item.merged,
    merged_at: item.mergedSeq === null ? null : store.iso(item.mergedSeq),
    merge_commit_sha: item.mergeCommitSha,
    created_at: store.iso(item.seq),
    updated_at: store.iso(item.seq),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${item.number}`,
  };
}

// ------------------------------------------------------------------ pull request diff & merge

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function linesOf(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData ? linesOf(oldData) : [];
  const newLines = newData ? linesOf(newData) : [];
  const remaining = new Map<string, number>();
  for (const line of oldLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of newLines) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) {
      remaining.set(line, count - 1);
      common += 1;
    }
  }
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/** The files a pull request changes: merge-base tree versus head tree. */
export function pullFiles(repo: RepoRec, item: ItemRec): FileChange[] {
  const headSha = repo.refs.get(`refs/heads/${item.headRef}`) ?? item.headSha;
  const baseSha = repo.refs.get(`refs/heads/${item.baseRef}`) ?? item.baseSha;
  const base = mergeBase(repo.objects, baseSha, headSha) ?? item.baseSha;
  const baseFiles = flattenCommit(repo.objects, base);
  const headFiles = flattenCommit(repo.objects, headSha);
  const changes: FileChange[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before?.oid === after?.oid) continue;
    const oldData = before ? repo.objects.get(before.oid)?.data ?? null : null;
    const newData = after ? repo.objects.get(after.oid)?.data ?? null : null;
    const counts = lineCounts(oldData, newData);
    changes.push({
      filename: path,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return changes;
}

/** Three-way file merge of head into the current base; the merged map, or null on conflict. */
function mergedFiles(repo: RepoRec, item: ItemRec): Map<string, FileEntry> | null {
  const headSha = repo.refs.get(`refs/heads/${item.headRef}`) ?? item.headSha;
  const baseSha = repo.refs.get(`refs/heads/${item.baseRef}`) ?? item.baseSha;
  const ancestor = mergeBase(repo.objects, baseSha, headSha);
  if (!ancestor) return null;
  const ancestorFiles = flattenCommit(repo.objects, ancestor);
  const headFiles = flattenCommit(repo.objects, headSha);
  const currentFiles = flattenCommit(repo.objects, baseSha);
  const merged = new Map(currentFiles);
  const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);
  for (const path of paths) {
    const ancestorEntry = ancestorFiles.get(path);
    const headEntry = headFiles.get(path);
    const currentEntry = currentFiles.get(path);
    if (headEntry?.oid === ancestorEntry?.oid) continue; // the head did not touch it
    if (currentEntry?.oid === ancestorEntry?.oid || currentEntry?.oid === headEntry?.oid) {
      if (headEntry) merged.set(path, headEntry);
      else merged.delete(path);
      continue;
    }
    return null; // both sides changed the same path differently
  }
  return merged;
}

/** Whether a pull request can merge cleanly right now (the GraphQL mergeable state). */
export function pullMergeable(repo: RepoRec, item: ItemRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (item.merged || item.state !== 'open') return 'UNKNOWN';
  return mergedFiles(repo, item) === null ? 'CONFLICTING' : 'MERGEABLE';
}

/** Merge a pull request (squash or merge commit) onto its base branch. Throws ApiError(405) on conflict. */
export function mergePullRequest(repo: RepoRec, item: ItemRec, method: 'squash' | 'merge'): { sha: string } {
  if (item.merged || item.state !== 'open') throw new ApiError(405, 'Pull Request is not mergeable');
  const headSha = repo.refs.get(`refs/heads/${item.headRef}`) ?? item.headSha;
  const baseSha = repo.refs.get(`refs/heads/${item.baseRef}`);
  if (!headSha || !baseSha) throw new ApiError(405, 'Pull Request is not mergeable');
  const files = mergedFiles(repo, item);
  if (files === null) throw new ApiError(405, 'Pull Request is not mergeable');
  const tree = buildTreeFromFiles(repo.objects, files);
  const stamp = store.tick();
  const ident = identLine(store.viewer.name, store.viewer.email, stamp);
  const message =
    method === 'squash'
      ? `${item.title}\n${item.body ? `\n${item.body}\n` : ''}`
      : `Merge pull request #${item.number} from ${item.headRef}\n\n${item.title}\n`;
  const parents = method === 'squash' ? [baseSha] : [baseSha, headSha];
  const commit = putObject(repo.objects, 'commit', buildCommit({ tree, parents, author: ident, committer: ident, message }));
  repo.refs.set(`refs/heads/${item.baseRef}`, commit);
  item.merged = true;
  item.state = 'closed';
  item.mergeCommitSha = commit;
  item.mergedSeq = store.tick();
  return { sha: commit };
}

// ------------------------------------------------------------------ helpers

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
  body: Record<string, unknown>;
}

function requireRepo(owner: string, name: string): RepoRec {
  const repo = store.findRepo(owner, name);
  if (!repo) throw notFound();
  return repo;
}

function paginate<T>(ctx: Ctx, items: readonly T[], basePath: string): { page: T[]; headers: Record<string, string> } {
  const perPageRaw = Number.parseInt(ctx.url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(ctx.url.searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const host = ctx.req.headers.host ?? 'entry';
    const last = Math.ceil(items.length / perPage);
    const make = (p: number) => `<http://${host}${basePath}?per_page=${perPage}&page=${p}>`;
    headers.link = `${make(page + 1)}; rel="next", ${make(last)}; rel="last"`;
  }
  return { page: slice as T[], headers };
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function resolveCommit(repo: RepoRec, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag) return tag;
  if (/^[0-9a-f]{40}$/i.test(ref) && repo.objects.get(ref.toLowerCase())?.type === 'commit') return ref.toLowerCase();
  const full = repo.refs.get(ref);
  if (full) return full;
  return null;
}

// ------------------------------------------------------------------ contents

function contentsGet(ctx: Ctx, repo: RepoRec, path: string): void {
  const ref = ctx.url.searchParams.get('ref') ?? undefined;
  const commit = resolveCommit(repo, ref);
  if (!commit) throw notFound();
  const commitObject = repo.objects.get(commit);
  if (!commitObject) throw notFound();
  const rootTree = parseCommit(commitObject.data).tree;

  // Navigate to the target: a tree walk so directory entries carry their real tree/blob shas.
  let treeOid = rootTree;
  const segments = path === '' ? [] : path.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') throw notFound();
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) throw notFound();
    if (i === segments.length - 1) {
      if (entry.mode === '40000') {
        sendJson(ctx.res, 200, dirListing(repo, entry.oid, path));
        return;
      }
      const blob = repo.objects.get(entry.oid);
      if (!blob) throw notFound();
      sendJson(ctx.res, 200, {
        type: 'file',
        name: entry.name,
        path,
        sha: entry.oid,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
      });
      return;
    }
    if (entry.mode !== '40000') throw notFound();
    treeOid = entry.oid;
  }
  sendJson(ctx.res, 200, dirListing(repo, rootTree, ''));
}

function dirListing(repo: RepoRec, treeOid: string, dirPath: string) {
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') throw notFound();
  return parseTree(tree.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
    sha: entry.oid,
  }));
}

/** Prepare a branch for a contents write: fork it from the default branch when it is new. */
function branchForWrite(repo: RepoRec, branch: string): void {
  const ref = `refs/heads/${branch}`;
  if (repo.refs.has(ref)) return;
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip && branch !== repo.defaultBranch) repo.refs.set(ref, defaultTip);
}

function contentsPut(ctx: Ctx, repo: RepoRec, path: string): void {
  const body = ctx.body;
  const message = stringField(body, 'message') ?? 'Update file';
  const content64 = stringField(body, 'content');
  if (content64 === undefined) throw new ApiError(422, 'content is required');
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  branchForWrite(repo, branch);
  const files = store.filesAtBranch(repo, branch);
  const existing = files.get(path);
  const sha = stringField(body, 'sha');
  if (existing) {
    if (sha === undefined) throw new ApiError(422, 'sha is required when updating a file');
    if (sha !== existing.oid) throw new ApiError(409, `${path} does not match ${sha}`);
  }
  const data = Buffer.from(content64.replace(/\s+/g, ''), 'base64');
  const blob = putObject(repo.objects, 'blob', data);
  files.set(path, { oid: blob, mode: existing?.mode ?? '100644' });
  const commit = store.commitFiles(repo, branch, files, message);
  sendJson(ctx.res, existing ? 200 : 201, {
    content: { name: path.split('/').pop(), path, sha: blob, size: data.length, type: 'file', encoding: 'base64' },
    commit: { sha: commit },
  });
}

function contentsDelete(ctx: Ctx, repo: RepoRec, path: string): void {
  const body = ctx.body;
  const message = stringField(body, 'message') ?? 'Delete file';
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const files = store.filesAtBranch(repo, branch);
  const existing = files.get(path);
  if (!existing) throw notFound();
  const sha = stringField(body, 'sha');
  if (sha !== undefined && sha !== existing.oid) throw new ApiError(409, `${path} does not match ${sha}`);
  files.delete(path);
  const commit = store.commitFiles(repo, branch, files, message);
  sendJson(ctx.res, 200, { content: null, commit: { sha: commit } });
}

// ------------------------------------------------------------------ commits

function identParts(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', date: store.iso(store.tick()) };
  return { name: match[1] as string, email: match[2] as string, date: store.iso(Number.parseInt(match[3] as string, 10)) };
}

function commitJson(repo: RepoRec, oid: string) {
  const object = repo.objects.get(oid);
  if (!object) throw notFound();
  const commit = parseCommit(object.data);
  return {
    sha: oid,
    commit: {
      message: commit.message.replace(/\n+$/, ''),
      author: identParts(commit.author),
      committer: identParts(commit.committer),
      tree: { sha: commit.tree },
    },
    author: userJson(store.viewer.login),
    committer: userJson(store.viewer.login),
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function listCommits(ctx: Ctx, repo: RepoRec): void {
  const start = resolveCommit(repo, ctx.url.searchParams.get('sha') ?? undefined);
  if (!start) {
    sendJson(ctx.res, 200, []);
    return;
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  const { page, headers } = paginate(ctx, order, `/api/v3/repos/${repo.owner}/${repo.name}/commits`);
  sendJson(ctx.res, 200, page.map((oid) => commitJson(repo, oid)), headers);
}

// ------------------------------------------------------------------ issues & pulls

function labelNamesOf(body: Record<string, unknown>): string[] | undefined {
  const raw = body.labels;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new ApiError(422, 'labels must be an array');
  return raw.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      return (entry as { name: string }).name;
    }
    throw new ApiError(422, 'labels must be names');
  });
}

function validateLabels(repo: RepoRec, names: string[]): void {
  for (const name of names) {
    if (!repo.labels.has(name)) throw new ApiError(422, `Label "${name}" does not exist`);
  }
}

function createIssue(ctx: Ctx, repo: RepoRec): void {
  const title = stringField(ctx.body, 'title');
  if (title === undefined || title === '') throw new ApiError(422, 'title is required');
  const labels = labelNamesOf(ctx.body) ?? [];
  validateLabels(repo, labels);
  const item = store.newItem(repo, 'issue', { title, body: stringField(ctx.body, 'body') ?? '', labels });
  sendJson(ctx.res, 201, issueJson(repo, item));
}

function listIssues(ctx: Ctx, repo: RepoRec): void {
  const state = ctx.url.searchParams.get('state') ?? 'open';
  let items = repo.items.filter((item) => item.kind === 'issue');
  if (state === 'open' || state === 'closed') items = items.filter((item) => item.state === state);
  else if (state !== 'all') items = items.filter((item) => item.state === 'open');
  const direction = ctx.url.searchParams.get('direction') ?? 'desc';
  items = [...items].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const { page, headers } = paginate(ctx, items, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
  sendJson(ctx.res, 200, page.map((item) => issueJson(repo, item)), headers);
}

function requireItem(repo: RepoRec, number: number, kind?: 'issue' | 'pr'): ItemRec {
  const item = store.findItem(repo, number);
  if (!item || (kind !== undefined && item.kind !== kind)) throw notFound();
  return item;
}

function createPull(ctx: Ctx, repo: RepoRec): void {
  const title = stringField(ctx.body, 'title');
  const headRaw = stringField(ctx.body, 'head');
  const baseRaw = stringField(ctx.body, 'base');
  if (title === undefined || headRaw === undefined || baseRaw === undefined) {
    throw new ApiError(422, 'title, head and base are required');
  }
  const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
  const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) throw new ApiError(422, 'head or base branch does not exist');
  if (head === base) throw new ApiError(422, 'head and base are the same');
  const existing = repo.items.find(
    (item) => item.kind === 'pr' && item.state === 'open' && item.headRef === head && item.baseRef === base,
  );
  if (existing) throw new ApiError(422, `A pull request already exists for ${head} into ${base}`);
  const item = store.newItem(repo, 'pr', {
    title,
    body: stringField(ctx.body, 'body') ?? '',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
  });
  sendJson(ctx.res, 201, pullJson(repo, item));
}

function listPulls(ctx: Ctx, repo: RepoRec): void {
  const state = ctx.url.searchParams.get('state') ?? 'open';
  let items = repo.items.filter((item) => item.kind === 'pr');
  if (state === 'open' || state === 'closed') items = items.filter((item) => item.state === state);
  const { page, headers } = paginate(ctx, items, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
  sendJson(ctx.res, 200, page.map((item) => pullJson(repo, item)), headers);
}

// ------------------------------------------------------------------ router

/** Serve one /api/v3 request (the caller has already authenticated it, except the API root). */
export async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await guard(res, async () => {
    const url = new URL(req.url ?? '/', 'http://entry');
    const segments = url.pathname
      .split('/')
      .filter((part) => part !== '')
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      });
    // segments[0] === 'api', segments[1] === 'v3'
    const rest = segments.slice(2);
    const method = req.method ?? 'GET';
    const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    const body = raw.length > 0 ? parseJsonBody(raw) : {};
    const ctx: Ctx = { req, res, url, segments, body };

    if (rest.length === 0) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    if (rest[0] === 'meta' && method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0-forge' });
      return;
    }
    if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
      sendJson(res, 200, userJson(store.viewer.login));
      return;
    }
    if (rest[0] === 'user' && rest[1] === 'repos') {
      if (method === 'POST') {
        const name = stringField(body, 'name');
        if (name === undefined || name === '') throw new ApiError(422, 'name is required');
        if (store.findRepo(store.viewer.login, name)) throw new ApiError(422, 'name already exists on this account');
        const repo = store.createRepo(store.viewer.login, name, {
          description: stringField(body, 'description') ?? '',
          isPrivate: typeof body.private === 'boolean' ? body.private : false,
          autoInit: body.auto_init === true,
        });
        sendJson(res, 201, repoJson(repo));
        return;
      }
      if (method === 'GET') {
        const { page, headers } = paginate(ctx, store.reposOf(store.viewer.login), '/api/v3/user/repos');
        sendJson(res, 200, page.map((repo) => repoJson(repo)), headers);
        return;
      }
    }
    if (rest[0] === 'repos' && rest.length >= 3) {
      const repo = requireRepo(rest[1] as string, rest[2] as string);
      const tail = rest.slice(3);
      await routeRepo(ctx, repo, tail);
      return;
    }
    throw notFound();
  });
}

async function routeRepo(ctx: Ctx, repo: RepoRec, tail: string[]): Promise<void> {
  const { res } = ctx;
  const method = ctx.req.method ?? 'GET';
  const body = ctx.body;

  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const description = stringField(body, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      res.writeHead(204, { 'x-github-request-id': store.requestId() });
      res.end();
      return;
    }
    throw notFound();
  }

  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') return contentsGet(ctx, repo, path);
    if (method === 'PUT') return contentsPut(ctx, repo, path);
    if (method === 'DELETE') return contentsDelete(ctx, repo, path);
    throw notFound();
  }

  if (tail[0] === 'git' && (tail[1] === 'refs' || tail[1] === 'ref')) {
    if (method === 'POST' && tail.length === 2) {
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) throw new ApiError(422, 'ref and sha are required');
      const object = repo.objects.get(sha.toLowerCase());
      if (!object) throw new ApiError(422, 'sha does not name an object');
      if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
      repo.refs.set(ref, sha.toLowerCase());
      sendJson(res, 201, { ref, object: { sha: sha.toLowerCase(), type: object.type } });
      return;
    }
    if (method === 'GET' && tail.length >= 3) {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) throw notFound();
      const object = repo.objects.get(sha);
      sendJson(res, 200, { ref, object: { sha, type: object?.type ?? 'commit' } });
      return;
    }
    throw notFound();
  }

  if (tail[0] === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, branches);
      return;
    }
    if (method === 'GET' && tail.length >= 2) {
      const name = tail.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (!sha) throw notFound();
      sendJson(res, 200, { name, commit: { sha }, protected: false });
      return;
    }
    throw notFound();
  }

  if (tail[0] === 'commits' && method === 'GET' && tail.length === 1) {
    listCommits(ctx, repo);
    return;
  }

  if (tail[0] === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })));
      return;
    }
    if (method === 'POST' && tail.length === 1) {
      const name = stringField(body, 'name');
      if (name === undefined || name === '') throw new ApiError(422, 'name is required');
      if (repo.labels.has(name)) throw new ApiError(422, 'Label already exists');
      const label = { name, color: stringField(body, 'color') ?? 'ededed', description: stringField(body, 'description') ?? '' };
      repo.labels.set(name, label);
      sendJson(res, 201, label);
      return;
    }
    throw notFound();
  }

  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') return createIssue(ctx, repo);
      if (method === 'GET') return listIssues(ctx, repo);
      throw notFound();
    }
    const number = Number.parseInt(tail[1] as string, 10);
    if (tail.length === 2) {
      const item = requireItem(repo, number);
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, item));
        return;
      }
      if (method === 'PATCH') {
        const title = stringField(body, 'title');
        if (title !== undefined) item.title = title;
        const nextBody = stringField(body, 'body');
        if (nextBody !== undefined) item.body = nextBody;
        const state = stringField(body, 'state');
        if (state === 'closed' || state === 'open') item.state = state;
        const labels = labelNamesOf(body);
        if (labels !== undefined) {
          validateLabels(repo, labels);
          item.labels = labels;
        }
        sendJson(res, 200, issueJson(repo, item));
        return;
      }
      throw notFound();
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      const item = requireItem(repo, number);
      if (method === 'GET') {
        const { page, headers } = paginate(ctx, item.comments, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments`);
        sendJson(res, 200, page.map((comment) => commentJson(repo, item, comment)), headers);
        return;
      }
      if (method === 'POST') {
        const text = stringField(body, 'body');
        if (text === undefined) throw new ApiError(422, 'body is required');
        const comment = store.addComment(item, text, store.viewer.login);
        sendJson(res, 201, commentJson(repo, item, comment));
        return;
      }
      throw notFound();
    }
    throw notFound();
  }

  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') return createPull(ctx, repo);
      if (method === 'GET') return listPulls(ctx, repo);
      throw notFound();
    }
    const number = Number.parseInt(tail[1] as string, 10);
    if (tail.length === 2 && method === 'GET') {
      const item = requireItem(repo, number, 'pr');
      sendJson(res, 200, pullJson(repo, item));
      return;
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      const item = requireItem(repo, number, 'pr');
      sendJson(res, 200, pullFiles(repo, item));
      return;
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      const item = store.findItem(repo, number);
      if (!item || item.kind !== 'pr') throw notFound();
      const methodField = stringField(body, 'merge_method') ?? 'merge';
      const result = mergePullRequest(repo, item, methodField === 'merge' ? 'merge' : 'squash');
      sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    throw notFound();
  }

  throw notFound();
}
