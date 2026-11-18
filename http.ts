// Shared HTTP plumbing for the forge's surfaces: body reading, JSON answers, and the one error
// type handlers throw to answer with a GitHub-shaped {message} body at a chosen status.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** An error that maps directly onto an HTTP status and a {message} body. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function notFound(message = 'Not Found'): ApiError {
  return new ApiError(404, message);
}

/** Read a request body whole (the largest legitimate body here is a benchmark pack, far under the cap). */
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > 128 * 1024 * 1024) throw new ApiError(413, 'Request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON request body; an empty body reads as an empty object, malformed JSON is a 400. */
export function parseJsonBody(raw: Buffer): Record<string, unknown> {
  if (raw.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'Invalid request, expected an object');
  }
  return value as Record<string, unknown>;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.requestId(),
    ...headers,
  });
  res.end(text);
}

export function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Run a handler, translating ApiError (and anything unexpected) into a JSON answer. */
export async function guard(res: ServerResponse, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof ApiError) {
      sendJson(res, err.status, { message: err.message });
    } else {
      sendJson(res, 500, { message: 'Internal Server Error' });
    }
  }
}

/** The bearer-token check every protected surface shares (open only when no token is configured). */
export function isAuthed(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${expected}` || header === `token ${expected}`;
}
