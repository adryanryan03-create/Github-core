// The forge's HTTP surface, wired into one server: a health probe, git smart HTTP at
// /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL at /api/graphql, and MCP at /mcp.
// main.ts owns the lifecycle (bind an ephemeral port, register with the env, wait for done);
// this file is only routing and the shared bearer-token gate.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAuthed, sendJson } from './http.ts';
import { handleGit } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}. It carries no token.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // The GitHub API root answers without a token, as the starter ships it.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    await handleRest(req, res);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git[/info/refs|/git-upload-pack|/git-receive-pack]
  const gitMatch = /^\/([^/]+)\/(.+)\.git(\/.*)?$/.exec(path);
  if (gitMatch) {
    if (!isAuthed(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    await handleGit(req, res, safeDecode(gitMatch[1] as string), safeDecode(gitMatch[2] as string), gitMatch[3] ?? '');
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!isAuthed(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    await handleRest(req, res);
    return;
  }

  if (path === '/api/graphql' || path === '/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!isAuthed(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    await handleGraphql(req, res);
    return;
  }

  if (path === '/mcp') {
    await handleMcp(req, res);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}
