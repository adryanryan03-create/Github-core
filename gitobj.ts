// Git object model over an in-memory store: SHA-1 addressed commits, trees, blobs and tags,
// packfile read/write (full objects out; OFS/REF deltas in), ancestry and tree flatten/rebuild
// helpers shared by the smart-HTTP protocol, the contents API and pull-request merges.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}
export type ObjectMap = Map<string, GitObject>;

export const ZERO_OID = '0000000000000000000000000000000000000000';
const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function objectId(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function putObject(store: ObjectMap, type: ObjType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// ------------------------------------------------------------------ commits, trees, tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`, '', info.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** An author/committer identity line with a fixed-offset timestamp. */
export function identLine(name: string, email: string, epochSeconds: number): string {
  return `${name} <${email}> ${epochSeconds} +0000`;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const out: TagInfo = { object: '', type: '', tag: '', tagger: '', message: split >= 0 ? text.slice(split + 2) : '' };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: bytewise by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Peel tags to the commit they ultimately name (null when the chain leaves the store). */
export function peelToCommit(store: ObjectMap, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 32; depth += 1) {
    const object = store.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** The commit a ref value names, following tags; null for blobs/trees/missing. */
export function peelTag(store: ObjectMap, oid: string): string | null {
  const object = store.get(oid);
  if (!object || object.type !== 'tag') return null;
  return peelToCommit(store, oid);
}

// ------------------------------------------------------------------ reachability

/**
 * Every object reachable from the roots (commits walk parents and trees; tags walk their target).
 * With `exclude`, excluded objects are pruned — neither returned nor descended into — which is
 * exact for a send-set difference: anything reachable only through an excluded object is itself
 * in the excluded closure, and anything reachable another way is still visited that way.
 */
export function fullClosure(store: ObjectMap, roots: readonly string[], exclude?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    if (exclude?.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** The commit plus its full tree (trees and blobs), without ancestors. */
export function commitTreeClosure(store: ObjectMap, commitOid: string): Set<string> {
  const seen = new Set<string>();
  const commit = store.get(commitOid);
  if (!commit || commit.type !== 'commit') return seen;
  seen.add(commitOid);
  const stack = [parseCommit(commit.data).tree];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` through commit parents (or equal). */
export function isAncestor(store: ObjectMap, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** All ancestors of a commit (including itself), nearest first (BFS). */
export function ancestorsOf(store: ObjectMap, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    queue.push(...parseCommit(object.data).parents);
  }
  return order;
}

/** The best common ancestor of two commits, or null. */
export function mergeBase(store: ObjectMap, a: string, b: string): string | null {
  const ancestors = new Set(ancestorsOf(store, a));
  for (const candidate of ancestorsOf(store, b)) {
    if (ancestors.has(candidate)) return candidate;
  }
  return null;
}

// ------------------------------------------------------------------ flat file maps

export interface FileEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree (by oid) into path -> blob entry. */
export function flattenTree(store: ObjectMap, treeOid: string, prefix = '', out = new Map<string, FileEntry>()): Map<string, FileEntry> {
  const object = store.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

export function flattenCommit(store: ObjectMap, commitOid: string): Map<string, FileEntry> {
  const object = store.get(commitOid);
  if (!object || object.type !== 'commit') return new Map();
  return flattenTree(store, parseCommit(object.data).tree);
}

/** Build (and store) nested trees from a flat path -> entry map; returns the root tree oid. */
export function buildTreeFromFiles(store: ObjectMap, files: Map<string, FileEntry>): string {
  interface Dir {
    files: Map<string, FileEntry>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      let next = dir.dirs.get(segment);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.set(segments[segments.length - 1] as string, entry);
  }
  const write = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: write(sub) });
    return putObject(store, 'tree', buildTree(entries));
  };
  return write(root);
}

// ------------------------------------------------------------------ packfiles

function packEntryHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A version-2 pack of full (never delta) objects, with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset++] as number) * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset++] as number) * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface ParsedPack {
  objects: GitObject[];
  byOid: Map<string, GitObject>;
}

/**
 * Parse a pack, resolving OFS/REF deltas. REF-delta bases not in the pack itself are looked up
 * through `resolveBase` (the receiving repo's store), which is how thin packs land.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): ParsedPack {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const expected = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  const actual = pack.subarray(trailerStart).toString('hex');
  if (expected !== actual) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    type: ObjType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack entry header is truncated');
    let byte = pack[offset++] as number;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry header is truncated');
      byte = pack[offset++] as number;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    let type: RawEntry['type'];
    if (code === 6) {
      if (offset >= trailerStart) throw new Error('ofs-delta base is truncated');
      let b = pack[offset++] as number;
      let value = b & 0x7f;
      while (b & 0x80) {
        if (offset >= trailerStart) throw new Error('ofs-delta base is truncated');
        b = pack[offset++] as number;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      baseOffset = entryOffset - value;
      type = 'ofs-delta';
    } else if (code === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base is truncated');
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      type = 'ref-delta';
    } else {
      const named = CODE_TYPES[code];
      if (!named) throw new Error(`pack entry type ${code} is not supported`);
      type = named;
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== size) throw new Error(`pack entry declares ${size} bytes but inflated to ${inflated.data.length}`);
    offset = inflated.next;
    byOffset.set(entryOffset, raw.length);
    raw.push({ offset: entryOffset, type, data: inflated.data, baseOffset, baseOid });
  }

  const resolved: Array<GitObject | null> = raw.map(() => null);
  const byOid = new Map<string, GitObject>();
  const resolveIndex = (index: number): GitObject => {
    const memo = resolved[index];
    if (memo) return memo;
    const entry = raw[index] as RawEntry;
    let object: GitObject;
    if (entry.type === 'ofs-delta') {
      const baseIndex = byOffset.get(entry.baseOffset as number);
      if (baseIndex === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolveIndex(baseIndex);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.type === 'ref-delta') {
      let base = byOid.get(entry.baseOid as string);
      if (!base) {
        // The base may be a later pack entry; scan the raw list for a full object with that id.
        for (let j = 0; j < raw.length; j += 1) {
          const candidate = raw[j] as RawEntry;
          if (candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta' && objectId(candidate.type, candidate.data) === entry.baseOid) {
            base = resolveIndex(j);
            break;
          }
        }
      }
      if (!base && resolveBase) base = resolveBase(entry.baseOid as string);
      if (!base) throw new Error(`ref-delta base ${entry.baseOid} is not available`);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.type, data: entry.data };
    }
    resolved[index] = object;
    byOid.set(objectId(object.type, object.data), object);
    return object;
  };
  const objects: GitObject[] = [];
  for (let i = 0; i < raw.length; i += 1) objects.push(resolveIndex(i));
  return { objects, byOid };
}
