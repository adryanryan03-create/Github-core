// The MCP endpoint: JSON-RPC over POST /mcp in both protocol eras — the modern
// server/discover handshake (revision 2026-07-28) and the legacy initialize handshake —
// with a static tools list (byte-identical across calls) whose tools act on the same store
// the REST and GraphQL surfaces serve.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { guard, isAuthed, readBody, sendJson } from './http.ts';
import { store, type RepoRec } from './store.ts';
import { issueJson, mergePullRequest, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const str = (description: string) => ({ type: 'string', description });

/** The tools list, built once and served verbatim forever (the idempotence check compares bytes). */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('The repository name'),
        description: str('A short description of the repository'),
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: str('The repository owner login'), repo: str('The repository name') },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
        title: str('The issue title'),
        body: str('The issue body'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed, all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
        state: str('Issue state filter: open, closed or all'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
        title: str('The pull request title'),
        body: str('The pull request body'),
        head: str('The head branch name'),
        base: str('The base branch name'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

interface RpcOutcome {
  status: number;
  payload: Record<string, unknown> | null;
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): RpcOutcome {
  return { status, payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requireRepo(owner: string, repo: string): RepoRec {
  const found = store.findRepo(owner, repo);
  if (!found) throw new Error(`Repository ${owner}/${repo} not found`);
  return found;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) throw new ToolUnknown(name);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolFailure(`Missing required argument: ${required}`);
    }
  }
  const owner = typeof args.owner === 'string' ? args.owner : store.viewer.login;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  try {
    switch (name) {
      case 'create_repo': {
        const repoNameArg = typeof args.name === 'string' ? args.name : repoName;
        if (!repoNameArg) return toolFailure('Missing required argument: name');
        const existing = store.findRepo(store.viewer.login, repoNameArg);
        if (existing) return toolResult(repoJson(existing));
        const repo = store.createRepo(store.viewer.login, repoNameArg, {
          description: typeof args.description === 'string' ? args.description : '',
          isPrivate: typeof args.private === 'boolean' ? args.private : false,
        });
        return toolResult(repoJson(repo));
      }
      case 'get_repo':
        return toolResult(repoJson(requireRepo(owner, repoName)));
      case 'create_issue': {
        const repo = requireRepo(owner, repoName);
        const item = store.newItem(repo, 'issue', {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
        });
        return toolResult(issueJson(repo, item));
      }
      case 'list_issues': {
        const repo = requireRepo(owner, repoName);
        const state = typeof args.state === 'string' ? args.state : 'open';
        let items = repo.items.filter((item) => item.kind === 'issue');
        if (state === 'open' || state === 'closed') items = items.filter((item) => item.state === state);
        return toolResult(items.map((item) => issueJson(repo, item)));
      }
      case 'create_pull_request': {
        const repo = requireRepo(owner, repoName);
        const head = String(args.head);
        const base = String(args.base);
        const existing = repo.items.find(
          (item) => item.kind === 'pr' && item.state === 'open' && item.headRef === head && item.baseRef === base,
        );
        if (existing) return toolResult(pullJson(repo, existing));
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) return toolFailure(`Branch ${!headSha ? head : base} does not exist`);
        const item = store.newItem(repo, 'pr', {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          headRef: head,
          baseRef: base,
          headSha,
          baseSha,
        });
        return toolResult(pullJson(repo, item));
      }
      case 'merge_pull_request': {
        const repo = requireRepo(owner, repoName);
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
        const item = store.findItem(repo, number);
        if (!item || item.kind !== 'pr') return toolFailure(`Pull request #${number} not found`);
        mergePullRequest(repo, item, 'squash');
        return toolResult(pullJson(repo, item));
      }
    }
  } catch (err) {
    if (err instanceof ToolUnknown) throw err;
    return toolFailure(err instanceof Error ? err.message : String(err));
  }
  return toolFailure(`Tool ${name} is not implemented`);
}

class ToolUnknown extends Error {
  constructor(name: string) {
    super(`Unknown tool: ${name}`);
  }
}

const NO_AUTH_METHODS = new Set(['server/discover', 'initialize', 'ping']);

function dispatch(message: Record<string, unknown>, authed: boolean): RpcOutcome | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const isNotification = id === undefined;

  if (!authed && !NO_AUTH_METHODS.has(method) && !method.startsWith('notifications/')) {
    return { status: 401, payload: { jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message: 'Unauthorized' } } };
  }

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26';
      return rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return rpcResult(id, callTool(name, args));
      } catch (err) {
        if (err instanceof ToolUnknown) return rpcError(id, -32602, err.message);
        throw err;
      }
    }
    default:
      if (isNotification || method.startsWith('notifications/')) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Best-effort id recovery from a malformed body, so the parse error can name it. */
function salvageId(raw: string): unknown {
  const match = /"id"\s*:\s*(\d+|"[^"]*")/.exec(raw);
  if (!match) return null;
  try {
    return JSON.parse(match[1] as string);
  } catch {
    return null;
  }
}

/** Serve the MCP endpoint (POST, plus DELETE for session teardown). */
export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await guard(res, async () => {
    if (req.method === 'DELETE') {
      sendJson(res, 200, {});
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } });
      return;
    }
    const raw = (await readBody(req)).toString('utf8');
    const authed = isAuthed(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: salvageId(raw), error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (Array.isArray(parsed)) {
      const outcomes: unknown[] = [];
      for (const entry of parsed) {
        const outcome = dispatch(entry as Record<string, unknown>, authed);
        if (outcome?.payload) outcomes.push(outcome.payload);
      }
      sendJson(res, 200, outcomes);
      return;
    }
    const outcome = dispatch(parsed as Record<string, unknown>, authed);
    if (outcome === null || outcome.payload === null) {
      res.writeHead(202, { 'x-github-request-id': store.requestId() });
      res.end();
      return;
    }
    sendJson(res, outcome.status, outcome.payload);
  });
}
