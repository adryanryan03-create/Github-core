// Git smart HTTP: ref advertisement (protocol v0 and v2), upload-pack (ls-refs and fetch,
// including shallow/deepen negotiation) and receive-pack (report-status over side-band-64k,
// fast-forward enforcement) — all against the repo's own in-memory object store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, readBody, sendJson, sendRaw } from './http.ts';
import { store, type RepoRec } from './store.ts';
import {
  ZERO_OID,
  commitTreeClosure,
  fullClosure,
  isAncestor,
  objectId,
  parseCommit,
  parseTag,
  peelTag,
  peelToCommit,
  readPack,
  writePack,
  type GitObject,
} from './gitobj.ts';

// ------------------------------------------------------------------ pkt-line framing

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

class PktReader {
  private offset = 0;
  private readonly body: Buffer;

  constructor(body: Buffer) {
    this.body = body;
  }

  get position(): number {
    return this.offset;
  }

  next(): Packet {
    if (this.offset + 4 > this.body.length) throw new Error('pkt-line stream is truncated');
    const header = this.body.subarray(this.offset, this.offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`pkt-line header ${JSON.stringify(header)} is not hex`);
    const length = parseInt(header, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.offset += 4;
      return { kind: 'end' };
    }
    if (length < 4 || this.offset + length > this.body.length) throw new Error('pkt-line length overruns the body');
    const payload = this.body.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', payload };
  }
}

/** Split a pack into side-band-64k band-1 packets (payload plus band byte stays under the pkt cap). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32768;
  for (let at = 0; at < pack.length; at += CHUNK) {
    packets.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(at, at + CHUNK)])));
  }
  if (pack.length === 0) packets.push(pkt(Buffer.from([1])));
  return packets;
}

// ------------------------------------------------------------------ advertisements

interface RefLine {
  name: string;
  oid: string;
  peeled: string | null;
}

function refLines(repo: RepoRec): RefLine[] {
  const lines: RefLine[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    lines.push({ name, oid, peeled: peelTag(repo.objects, oid) });
  }
  return lines;
}

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow agent=forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}` : RECEIVE_CAPS;
  const lines = refLines(repo);
  if (lines.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headRef = `refs/heads/${repo.defaultBranch}`;
    const headOid = repo.refs.get(headRef);
    let first = true;
    if (headOid) {
      parts.push(pkt(`${headOid} HEAD\0${caps}\n`));
      first = false;
    }
    for (const line of lines) {
      parts.push(pkt(first ? `${line.oid} ${line.name}\0${caps}\n` : `${line.oid} ${line.name}\n`));
      first = false;
      if (line.peeled) parts.push(pkt(`${line.peeled} ${line.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt('agent=forge/1.0\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

// ------------------------------------------------------------------ fetch planning

interface FetchPlan {
  oids: string[];
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

// Pack cache: git objects are content-addressed and immutable, so a pack built for a
// given ordered oid list is valid forever and byte-identical to a rebuild. Repeated
// fetches of the same send set (e.g. concurrent clones of one tip) reuse the buffer
// instead of re-deflating every object. LRU-bounded two ways: at most 128 entries
// and at most ~64 MiB of pack bytes, so unknown repo sizes cannot grow it into the
// pod's memory cap. A single pack larger than the byte cap is served uncached.
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX_ENTRIES = 128;
const PACK_CACHE_MAX_BYTES = 64 * 1024 * 1024;
let packCacheBytes = 0;

function packFor(plan: FetchPlan): Buffer {
  const key = plan.oids.join(' ');
  const hit = packCache.get(key);
  if (hit) {
    // Refresh recency: re-inserting moves the entry to the newest end of the map.
    packCache.delete(key);
    packCache.set(key, hit);
    return hit;
  }
  const pack = writePack(plan.objects);
  if (pack.length <= PACK_CACHE_MAX_BYTES) {
    packCache.set(key, pack);
    packCacheBytes += pack.length;
    while (packCache.size > PACK_CACHE_MAX_ENTRIES || packCacheBytes > PACK_CACHE_MAX_BYTES) {
      const oldest = packCache.keys().next().value as string;
      packCacheBytes -= (packCache.get(oldest) as Buffer).length;
      packCache.delete(oldest);
    }
  }
  return pack;
}

function planFetch(
  repo: RepoRec,
  wants: readonly string[],
  haves: readonly string[],
  shallowReq: readonly string[],
  depth: number | null,
): FetchPlan {
  const objects = repo.objects;
  for (const want of wants) {
    if (!objects.has(want)) throw new ApiError(400, `want ${want} is not an object here`);
  }
  const haveCommits = haves.filter((oid) => objects.get(oid)?.type === 'commit');

  if (depth === null) {
    const exclude = fullClosure(objects, haves.filter((oid) => objects.has(oid)));
    const send = fullClosure(objects, wants, exclude);
    const oids = [...send];
    return { oids, objects: oids.map((oid) => objects.get(oid) as GitObject), shallow: [], unshallow: [] };
  }

  // Depth-limited: the client's held set is each have's own commit + tree closure (a shallow
  // client holds no ancestors), and traversal walks through held commits to reach deeper ones.
  const exclude = new Set<string>();
  for (const oid of [...haves, ...shallowReq]) {
    const commit = objects.get(oid)?.type === 'tag' ? peelToCommit(objects, oid) : oid;
    if (commit && objects.get(commit)?.type === 'commit') {
      for (const held of commitTreeClosure(objects, commit)) exclude.add(held);
    }
  }
  const send = new Set<string>();
  const boundary = new Set<string>();
  const visited = new Set<string>();
  const addTreeClosure = (commitOid: string): void => {
    for (const oid of commitTreeClosure(objects, commitOid)) {
      if (!exclude.has(oid)) send.add(oid);
    }
  };
  const queue: Array<{ oid: string; level: number }> = [];
  for (const want of wants) {
    const object = objects.get(want) as GitObject;
    if (object.type === 'tag') {
      if (!exclude.has(want)) send.add(want);
      const target = peelToCommit(objects, want);
      if (target) queue.push({ oid: target, level: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, level: 1 });
    } else if (!exclude.has(want)) {
      send.add(want);
    }
  }
  while (queue.length) {
    const { oid, level } = queue.shift() as { oid: string; level: number };
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    if (!exclude.has(oid)) addTreeClosure(oid);
    const parents = parseCommit(object.data).parents;
    if (level >= depth) {
      if (parents.length > 0) boundary.add(oid);
    } else {
      for (const parent of parents) queue.push({ oid: parent, level: level + 1 });
    }
  }
  const unshallow = shallowReq.filter((oid) => visited.has(oid) && !boundary.has(oid));
  const oids = [...send];
  return {
    oids,
    objects: oids.map((oid) => objects.get(oid) as GitObject),
    shallow: [...boundary],
    unshallow,
  };
}

// ------------------------------------------------------------------ upload-pack

function lsRefs(repo: RepoRec, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const includeHead = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (includeHead) {
    if (headOid) lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    else if (unborn) lines.push(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
  }
  for (const line of refLines(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => line.name.startsWith(prefix))) continue;
    let text = `${line.oid} ${line.name}`;
    if (peel && line.peeled) text += ` peeled:${line.peeled}`;
    lines.push(text);
  }
  return Buffer.concat([...lines.map((line) => pkt(`${line}\n`)), FLUSH]);
}

function fetchV2(repo: RepoRec, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowReq: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowReq.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
  }
  const plan = planFetch(repo, wants, haves, shallowReq, depth);
  const pack = packFor(plan);
  const parts: Buffer[] = [pkt('acknowledgments\n')];
  const common = haves.find((oid) => repo.objects.has(oid));
  if (common) {
    parts.push(pkt(`ACK ${common}\n`), pkt('ready\n'));
  } else {
    parts.push(pkt('NAK\n'));
  }
  parts.push(DELIM);
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function uploadPackV2(repo: RepoRec, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const first = reader.next();
  if (first.kind !== 'data') throw new ApiError(400, 'expected a command packet');
  const commandLine = first.payload.toString('utf8').trim();
  const args: string[] = [];
  let sawDelim = false;
  for (;;) {
    const packet = reader.next();
    if (packet.kind === 'flush' || packet.kind === 'end') break;
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (sawDelim) args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (commandLine === 'command=ls-refs') return lsRefs(repo, args);
  if (commandLine === 'command=fetch') return fetchV2(repo, args);
  throw new ApiError(400, `unknown command ${commandLine}`);
}

function uploadPackV0(repo: RepoRec, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowReq: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (;;) {
    const packet = reader.next();
    if (packet.kind === 'end') break;
    if (packet.kind === 'flush') {
      section += 1;
      if (section >= 2) break;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowReq.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    // 'done' and capability words need no action.
  }
  const plan = planFetch(repo, wants, haves, shallowReq, depth);
  const pack = packFor(plan);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  const common = haves.find((oid) => repo.objects.has(oid));
  parts.push(pkt(common ? `ACK ${common}\n` : 'NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: RepoRec, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (;;) {
    const packet = reader.next();
    if (packet.kind === 'flush' || packet.kind === 'end') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (!match) throw new ApiError(400, `bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  const packBytes = body.subarray(reader.position);

  // Unpack into a view layered over the repo store; nothing is committed until validation passes.
  const view = new Map(repo.objects);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes, (oid) => view.get(oid));
      for (const object of parsed.objects) view.set(objectId(object.type, object.data), object);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    let reason: string | null = null;
    if (unpackError) {
      reason = 'unpack failed';
    } else if (command.oldOid !== current) {
      reason = 'reference is not up to date';
    } else if (command.newOid === ZERO_OID) {
      if (!repo.refs.has(command.ref)) reason = 'reference does not exist';
    } else {
      const target = view.get(command.newOid);
      if (!target) reason = 'new object is not present';
      else if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') reason = 'branch target is not a commit';
      else if (command.oldOid !== ZERO_OID && command.ref.startsWith('refs/heads/')) {
        const oldCommit = peelToCommit(view, command.oldOid);
        const newCommit = peelToCommit(view, command.newOid);
        if (!oldCommit || !newCommit || !isAncestor(view, oldCommit, newCommit)) reason = 'non-fast-forward';
      }
    }
    results.push({ ref: command.ref, ok: reason === null, reason: reason ?? '' });
  }

  if (!unpackError) {
    // Imported objects stay even for refused refs, as they do in git; refs move only on ok.
    for (const [oid, object] of view) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
    for (let i = 0; i < commands.length; i += 1) {
      const command = commands[i] as PushCommand;
      if (!results[i]?.ok) continue;
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
    }
  }

  const reportLines: string[] = [unpackError ? `unpack ${unpackError}` : 'unpack ok'];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason}`);
  }
  const report = Buffer.concat([...reportLines.map((line) => pkt(`${line}\n`)), FLUSH]);
  if (capabilities.split(' ').includes('side-band-64k')) {
    const packets: Buffer[] = [];
    const CHUNK = 32768;
    for (let at = 0; at < report.length; at += CHUNK) {
      packets.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(at, at + CHUNK)])));
    }
    packets.push(FLUSH);
    return Buffer.concat(packets);
  }
  return report;
}

// ------------------------------------------------------------------ entry point

/** Serve one git smart-HTTP request. `sub` is the path after /{owner}/{repo}.git. */
export async function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, name: string, sub: string): Promise<void> {
  const repo = store.findRepo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://entry');
  const method = req.method ?? 'GET';

  if (method === 'GET' && sub === '/info/refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 400, { message: 'Unknown service' });
      return;
    }
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const body = service === 'git-upload-pack' && wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
    sendRaw(res, 200, body, `application/x-${service}-advertisement`);
    return;
  }

  if (method === 'POST' && (sub === '/git-upload-pack' || sub === '/git-receive-pack')) {
    const service = sub.slice(1);
    const raw = await readBody(req);
    try {
      const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const out =
        service === 'git-receive-pack' ? receivePack(repo, raw) : wantsV2 ? uploadPackV2(repo, raw) : uploadPackV0(repo, raw);
      sendRaw(res, 200, out, `application/x-${service}-result`);
    } catch (err) {
      if (err instanceof ApiError) sendJson(res, err.status, { message: err.message });
      else sendJson(res, 400, { message: 'Malformed git request' });
    }
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
