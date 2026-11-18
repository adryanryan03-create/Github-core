// The forge's state: users, repositories (each with its own git object store and refs), issues,
// pull requests, comments and labels. Nothing here reads a wall clock — a logical tick counter
// stamps every record, so the state a run builds is a pure function of the requests it served.

import { USERS, VIEWER, type ForgeUser } from './wire.ts';
import {
  buildCommit,
  buildTreeFromFiles,
  flattenCommit,
  identLine,
  objectId,
  parseCommit,
  putObject,
  type FileEntry,
  type GitObject,
} from './gitobj.ts';

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  author: string;
  seq: number;
}

export interface ItemRec {
  id: number;
  number: number;
  kind: 'issue' | 'pr';
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  author: string;
  seq: number;
  // pull requests only
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedSeq: number | null;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  items: ItemRec[];
  nextNumber: number;
  labels: Map<string, LabelRec>;
  seq: number;
}

/** 2025-01-01T00:00:00Z: the logical clock's epoch. Every stamp is epoch + tick seconds. */
const EPOCH_SECONDS = 1735689600;

class Store {
  readonly users: readonly ForgeUser[] = USERS;
  readonly viewer: ForgeUser = VIEWER;
  readonly repos = new Map<string, RepoRec>();
  private repoIdCounter = 0;
  private itemIdCounter = 0;
  private commentIdCounter = 0;
  private tickCounter = 0;
  private requestCounter = 0;

  /** The next logical timestamp, in epoch seconds. */
  tick(): number {
    this.tickCounter += 1;
    return EPOCH_SECONDS + this.tickCounter;
  }

  iso(seconds: number): string {
    return new Date(seconds * 1000).toISOString();
  }

  /** A non-empty, unique-per-process request id for the X-GitHub-Request-Id header. */
  requestId(): string {
    this.requestCounter += 1;
    return `F${this.requestCounter.toString(16).toUpperCase().padStart(6, '0')}`;
  }

  userByLogin(login: string): ForgeUser | undefined {
    return this.users.find((user) => user.login === login);
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  findRepo(owner: string, name: string): RepoRec | undefined {
    const exact = this.repos.get(this.repoKey(owner, name));
    if (exact) return exact;
    const wanted = this.repoKey(owner, name).toLowerCase();
    for (const repo of this.repos.values()) {
      if (this.repoKey(repo.owner, repo.name).toLowerCase() === wanted) return repo;
    }
    return undefined;
  }

  reposOf(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  }

  createRepo(owner: string, name: string, options: { description?: string; isPrivate?: boolean; autoInit?: boolean }): RepoRec {
    this.repoIdCounter += 1;
    const repo: RepoRec = {
      id: this.repoIdCounter,
      owner,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      items: [],
      nextNumber: 1,
      labels: new Map(),
      seq: this.tick(),
    };
    // Labels start empty: the suite creates the labels it attaches (POST /labels must answer 201
    // for a name the repo has never seen), so no GitHub-style default set is pre-populated.
    this.repos.set(this.repoKey(owner, name), repo);
    if (options.autoInit) {
      const blob = putObject(repo.objects, 'blob', Buffer.from(`# ${name}\n`, 'utf8'));
      const files = new Map<string, FileEntry>([['README.md', { oid: blob, mode: '100644' }]]);
      const tree = buildTreeFromFiles(repo.objects, files);
      const stamp = this.tick();
      const ident = identLine(this.viewer.name, this.viewer.email, stamp);
      const commit = putObject(repo.objects, 'commit', buildCommit({ tree, parents: [], author: ident, committer: ident, message: 'Initial commit\n' }));
      repo.refs.set('refs/heads/main', commit);
    }
    return repo;
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  /** Allocate an issue or pull-request record with the repo's next shared number. */
  newItem(repo: RepoRec, kind: 'issue' | 'pr', init: Partial<ItemRec> & { title: string }): ItemRec {
    this.itemIdCounter += 1;
    const item: ItemRec = {
      id: this.itemIdCounter,
      number: repo.nextNumber,
      kind,
      title: init.title,
      body: init.body ?? '',
      state: 'open',
      labels: init.labels ?? [],
      comments: [],
      author: init.author ?? this.viewer.login,
      seq: this.tick(),
      headRef: init.headRef ?? '',
      baseRef: init.baseRef ?? '',
      headSha: init.headSha ?? '',
      baseSha: init.baseSha ?? '',
      merged: false,
      mergeCommitSha: null,
      mergedSeq: null,
    };
    repo.nextNumber += 1;
    repo.items.push(item);
    return item;
  }

  findItem(repo: RepoRec, number: number): ItemRec | undefined {
    return repo.items.find((item) => item.number === number);
  }

  addComment(item: ItemRec, body: string, author: string): CommentRec {
    this.commentIdCounter += 1;
    const comment: CommentRec = { id: this.commentIdCounter, body, author, seq: this.tick() };
    item.comments.push(comment);
    return comment;
  }

  /**
   * Commit a flat file map onto a branch as a new commit by the viewer; returns the commit oid.
   * The branch is created (as a root commit's ref) when it does not exist yet.
   */
  commitFiles(repo: RepoRec, branch: string, files: Map<string, FileEntry>, message: string): string {
    const tree = buildTreeFromFiles(repo.objects, files);
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    const stamp = this.tick();
    const ident = identLine(this.viewer.name, this.viewer.email, stamp);
    const commit = putObject(
      repo.objects,
      'commit',
      buildCommit({ tree, parents: parent ? [parent] : [], author: ident, committer: ident, message: message.endsWith('\n') ? message : `${message}\n` }),
    );
    repo.refs.set(ref, commit);
    return commit;
  }

  /** The flat file map at a branch's tip (empty for an unborn branch). */
  filesAtBranch(repo: RepoRec, branch: string): Map<string, FileEntry> {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return new Map();
    return flattenCommit(repo.objects, tip);
  }
}

/** The one store the process serves. */
export const store = new Store();

/** The blob oid for bytes, stored in the repo. */
export function blobOid(repo: RepoRec, data: Buffer): string {
  return putObject(repo.objects, 'blob', data);
}

/** Recompute an object's id (used when importing pack objects). */
export function oidOf(object: GitObject): string {
  return objectId(object.type, object.data);
}

export function commitInfo(repo: RepoRec, oid: string) {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data);
}
