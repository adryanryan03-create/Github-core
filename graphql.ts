// A small GraphQL executor for the forge's v4 surface: a parser for the query language the
// clients send (operations, variables, input objects, enum literals, aliases, inline fragments),
// a typed resolver tree over the same store the REST surface serves, Relay-style global ids,
// cursor connections, and the __type introspection the feature probes read.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { guard, readBody, sendJson } from './http.ts';
import { store, type ItemRec, type RepoRec } from './store.ts';
import { mergePullRequest, pullFiles, pullMergeable } from './rest.ts';
import type { ForgeUser } from './wire.ts';

// ------------------------------------------------------------------ global ids

function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoByGlobalId(id: string): RepoRec | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Repository') return null;
  const numeric = Number.parseInt(decoded.key, 10);
  for (const repo of store.repos.values()) if (repo.id === numeric) return repo;
  return null;
}

function itemByGlobalId(id: string, kind: 'issue' | 'pr'): { repo: RepoRec; item: ItemRec } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.type !== 'Issue' && decoded.type !== 'PullRequest') return null;
  const [repoIdText, numberText] = decoded.key.split(':');
  const repoId = Number.parseInt(repoIdText ?? '', 10);
  const number = Number.parseInt(numberText ?? '', 10);
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const item = store.findItem(repo, number);
    if (item && item.kind === kind) return { repo, item };
    return null;
  }
  return null;
}

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'enum'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface Directive {
  name: string;
  args: Record<string, Value>;
}

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, Value>;
  directives: Directive[];
  selection: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; directives: Directive[]; selection: SelectionNode[] }
  | { kind: 'spread'; name: string; directives: Directive[] };

/** A named fragment definition: its selection set plus the type it is `on`. */
interface FragmentDef {
  typeCondition: string;
  directives: Directive[];
  selection: SelectionNode[];
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class GqlSyntaxError extends Error {}

class Parser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private error(message: string): GqlSyntaxError {
    return new GqlSyntaxError(`${message} at offset ${this.pos}`);
  }

  private skipIgnored(): void {
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.pos += 1;
      } else if (ch === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
      } else {
        return;
      }
    }
  }

  private peek(): string {
    this.skipIgnored();
    return this.text[this.pos] ?? '';
  }

  private expect(ch: string): void {
    this.skipIgnored();
    if (this.text[this.pos] !== ch) throw this.error(`expected ${JSON.stringify(ch)}`);
    this.pos += 1;
  }

  private readName(): string {
    this.skipIgnored();
    const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(this.text.slice(this.pos));
    if (!match) throw this.error('expected a name');
    this.pos += match[0].length;
    return match[0];
  }

  private tryReadName(): string | null {
    this.skipIgnored();
    const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(this.text.slice(this.pos));
    if (!match) return null;
    this.pos += match[0].length;
    return match[0];
  }

  private readString(): string {
    this.skipIgnored();
    if (this.text.startsWith('"""', this.pos)) {
      const end = this.text.indexOf('"""', this.pos + 3);
      if (end < 0) throw this.error('unterminated block string');
      const value = this.text.slice(this.pos + 3, end);
      this.pos = end + 3;
      return value;
    }
    if (this.text[this.pos] !== '"') throw this.error('expected a string');
    this.pos += 1;
    let out = '';
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) throw this.error('unterminated string');
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        const esc = this.text[this.pos + 1];
        const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (esc === 'u') {
          out += String.fromCharCode(Number.parseInt(this.text.slice(this.pos + 2, this.pos + 6), 16));
          this.pos += 6;
        } else if (esc !== undefined && esc in simple) {
          out += simple[esc];
          this.pos += 2;
        } else {
          throw this.error('bad string escape');
        }
      } else {
        out += ch;
        this.pos += 1;
      }
    }
  }

  private readNumber(): number {
    this.skipIgnored();
    const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
    if (!match) throw this.error('expected a number');
    this.pos += match[0].length;
    return Number(match[0]);
  }

  private readValue(): Value {
    const ch = this.peek();
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'var', name: this.readName() };
    }
    if (ch === '"') return { kind: 'string', value: this.readString() };
    if (ch === '[') {
      this.pos += 1;
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.readValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: Record<string, Value> = {};
      while (this.peek() !== '}') {
        const name = this.readName();
        this.expect(':');
        fields[name] = this.readValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) return { kind: 'number', value: this.readNumber() };
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', name };
  }

  /** Skip a balanced (...) group (variable definitions, directive arguments). */
  private skipParens(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const ch = this.text[this.pos];
      if (ch === undefined) throw this.error('unterminated parentheses');
      if (ch === '"') {
        this.readString();
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      this.pos += 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.pos += 1;
      this.readName();
      if (this.peek() === '(') this.skipParens();
    }
  }

  /** Parse directives, keeping their arguments (for @include/@skip evaluation). */
  private readDirectives(): Directive[] {
    const directives: Directive[] = [];
    while (this.peek() === '@') {
      this.pos += 1;
      const name = this.readName();
      const args: Record<string, Value> = {};
      if (this.peek() === '(') {
        this.pos += 1;
        while (this.peek() !== ')') {
          const argName = this.readName();
          this.expect(':');
          args[argName] = this.readValue();
        }
        this.expect(')');
      }
      directives.push({ name, args });
    }
    return directives;
  }

  private readSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selection: SelectionNode[] = [];
    while (this.peek() !== '}') selection.push(this.readSelection());
    this.expect('}');
    return selection;
  }

  private readSelection(): SelectionNode {
    this.skipIgnored();
    if (this.text.startsWith('...', this.pos)) {
      this.pos += 3;
      const name = this.tryReadName();
      if (name === 'on') {
        const typeCondition = this.readName();
        const directives = this.readDirectives();
        return { kind: 'inline', typeCondition, directives, selection: this.readSelectionSet() };
      }
      if (name !== null && name !== '') {
        const directives = this.readDirectives();
        return { kind: 'spread', name, directives };
      }
      const directives = this.readDirectives();
      return { kind: 'inline', typeCondition: null, directives, selection: this.readSelectionSet() };
    }
    let name = this.readName();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.pos += 1;
      alias = name;
      name = this.readName();
    }
    const args: Record<string, Value> = {};
    if (this.peek() === '(') {
      this.pos += 1;
      while (this.peek() !== ')') {
        const argName = this.readName();
        this.expect(':');
        args[argName] = this.readValue();
      }
      this.expect(')');
    }
    const directives = this.readDirectives();
    const selection = this.peek() === '{' ? this.readSelectionSet() : null;
    return { kind: 'field', name, alias, args, directives, selection };
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDef> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    for (;;) {
      this.skipIgnored();
      if (this.pos >= this.text.length) break;
      if (this.peek() === '{') {
        operations.push({ type: 'query', name: null, selection: this.readSelectionSet() });
        continue;
      }
      const keyword = this.readName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        const next = this.peek();
        if (next !== '(' && next !== '{' && next !== '@') name = this.readName();
        if (this.peek() === '(') this.skipParens();
        if (this.peek() === '@') this.skipDirectives();
        operations.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selection: this.readSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragName = this.readName();
        const on = this.readName();
        if (on !== 'on') throw this.error('expected "on" in a fragment definition');
        const typeCondition = this.readName();
        const directives = this.readDirectives();
        fragments.set(fragName, { typeCondition, directives, selection: this.readSelectionSet() });
      } else {
        throw this.error(`unexpected keyword ${JSON.stringify(keyword)}`);
      }
    }
    return { operations, fragments };
  }
}

function resolveValue(value: Value, vars: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return vars[value.name];
    case 'enum':
      return value.name;
    case 'string':
      return value.value;
    case 'number':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value.fields)) out[key] = resolveValue(inner, vars);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema & execution

interface GqlError {
  message: string;
}

interface CommentData {
  id: number;
  body: string;
  author: string;
  seq: number;
}

type Source =
  | { type: 'User'; user: ForgeUser }
  | { type: 'Repository'; repo: RepoRec }
  | { type: 'Ref'; name: string }
  | { type: 'Issue'; repo: RepoRec; item: ItemRec }
  | { type: 'PullRequest'; repo: RepoRec; item: ItemRec }
  | { type: 'IssueComment'; repo: RepoRec; item: ItemRec; comment: CommentData }
  | { type: 'Label'; repo: RepoRec; name: string }
  | { type: 'Connection'; nodes: Source[]; hasNextPage: boolean; endCursor: string | null }
  | { type: 'PullRequestChangedFile'; path: string }
  | { type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { type: '__Type'; name: string }
  | { type: '__Field'; name: string }
  | { type: '__EnumValue'; name: string }
  | { type: 'CreateIssuePayload'; repo: RepoRec; item: ItemRec }
  | { type: 'CloseIssuePayload'; repo: RepoRec; item: ItemRec }
  | { type: 'CreatePullRequestPayload'; repo: RepoRec; item: ItemRec }
  | { type: 'MergePullRequestPayload'; repo: RepoRec; item: ItemRec }
  | { type: 'AddCommentPayload'; edge: Source }
  | { type: 'CommentEdge'; node: Source }
  | { type: 'Node'; inner: Source };

const CONNECTION_TYPES = new Set(['IssueConnection', 'PullRequestConnection', 'PullRequestFileConnection', 'LabelConnection']);

const OBJECT_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['id', 'name', 'prefix'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'labels', 'comments', 'author',
    'repository', 'createdAt', 'updatedAt', 'url', 'closed',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'url', 'mergedAt',
    'additions', 'deletions', 'changedFiles',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'interfaces', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
  CommentEdge: ['node', 'cursor'],
};

const ENUM_VALUES: Record<string, readonly string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1] as string, 10) : -1;
  } catch {
    return -1;
  }
}

interface ExecCtx {
  vars: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: GqlError[];
}

/**
 * Whether @include/@skip let a node through. Only a resolved boolean decides:
 * @skip(if: true) drops the node, @include(if: false) drops it; any other
 * directive — and any non-boolean `if` — leaves the node in place.
 */
function directivesAllow(directives: readonly Directive[], ctx: ExecCtx): boolean {
  for (const directive of directives) {
    const ifValue = directive.args.if;
    if (ifValue === undefined) continue;
    if (directive.name === 'skip' && resolveValue(ifValue, ctx.vars) === true) return false;
    if (directive.name === 'include' && resolveValue(ifValue, ctx.vars) === false) return false;
  }
  return true;
}

function typeMatches(typeCondition: string | null, typeName: string): boolean {
  return typeCondition === null || typeCondition === typeName || typeName === 'Node';
}

function flattenSelection(selection: SelectionNode[], ctx: ExecCtx, typeName: string): FieldNode[] {
  const fields: FieldNode[] = [];
  for (const node of selection) {
    if (node.kind === 'field') {
      if (directivesAllow(node.directives, ctx)) fields.push(node);
    } else if (node.kind === 'inline') {
      if (typeMatches(node.typeCondition, typeName) && directivesAllow(node.directives, ctx)) {
        fields.push(...flattenSelection(node.selection, ctx, typeName));
      }
    } else {
      const fragment = ctx.fragments.get(node.name);
      if (
        fragment &&
        typeMatches(fragment.typeCondition, typeName) &&
        directivesAllow(node.directives, ctx) &&
        directivesAllow(fragment.directives, ctx)
      ) {
        fields.push(...flattenSelection(fragment.selection, ctx, typeName));
      }
    }
  }
  return fields;
}

function execute(source: Source | null, typeName: string, selection: SelectionNode[], ctx: ExecCtx): unknown {
  if (source === null) return null;
  const out: Record<string, unknown> = {};
  for (const field of flattenSelection(selection, ctx, typeName)) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    out[key] = resolveField(source, typeName, field, ctx);
  }
  return out;
}

function sub(source: Source | null, typeName: string, field: FieldNode, ctx: ExecCtx): unknown {
  if (source === null) return null;
  if (!field.selection) return null;
  return execute(source, typeName, field.selection, ctx);
}

function subList(sources: Source[], field: FieldNode, ctx: ExecCtx): unknown {
  if (!field.selection) return [];
  return sources.map((source) => execute(source, source.type, field.selection as SelectionNode[], ctx));
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) args[key] = resolveValue(value, ctx.vars);
  return args;
}

function issueConnection(repo: RepoRec, args: Record<string, unknown>): Source {
  let items = repo.items.filter((item) => item.kind === 'issue');
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    items = items.filter((item) => wanted.has(item.state));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction ?? 'ASC';
  items = [...items].sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 25;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const index = indexFromCursor(args.after);
    if (index >= 0) start = index + 1;
  }
  const pageItems = items.slice(start, start + first);
  const hasNextPage = start + pageItems.length < items.length;
  const endCursor = pageItems.length > 0 ? cursorFor(start + pageItems.length - 1) : null;
  const conn: Source = {
    type: 'Connection',
    nodes: pageItems.map((item): Source => ({ type: 'Issue', repo, item })),
    hasNextPage,
    endCursor,
  };
  // Connections carry their schema name through the field's parent type; the executor maps the
  // generic Connection source onto the named connection type at the call site.
  (conn as { type: string }).type = 'IssueConnection';
  return conn;
}

function resolveField(source: Source, typeName: string, field: FieldNode, ctx: ExecCtx): unknown {
  if (source.type === 'Node') {
    return resolveField(source.inner, source.inner.type, field, ctx);
  }
  const args = argsOf(field, ctx);
  const name = field.name;

  if (name === '__type' && (typeName === 'Query' || typeName === 'Mutation')) {
    const typeNameArg = typeof args.name === 'string' ? args.name : '';
    if (OBJECT_FIELDS[typeNameArg] || ENUM_VALUES[typeNameArg]) {
      return sub({ type: '__Type', name: typeNameArg }, '__Type', field, ctx);
    }
    return null;
  }

  const known = OBJECT_FIELDS[typeName];
  if (!known || !known.includes(name)) {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
    return null;
  }

  switch (typeName) {
    case 'User': {
      const user = (source as { user: ForgeUser }).user;
      switch (name) {
        case 'id': return globalId('User', user.login);
        case 'databaseId': return user.id;
        case 'login': return user.login;
        case 'name': return user.name;
        case 'email': return user.email;
        case 'url': return `https://forge.invalid/${user.login}`;
      }
      break;
    }
    case 'Repository': {
      const repo = (source as { repo: RepoRec }).repo;
      switch (name) {
        case 'id': return globalId('Repository', String(repo.id));
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return sub({ type: 'User', user: store.userByLogin(repo.owner) ?? store.viewer }, 'User', field, ctx);
        case 'defaultBranchRef': return sub({ type: 'Ref', name: repo.defaultBranch }, 'Ref', field, ctx);
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'createdAt': return store.iso(repo.seq);
        case 'updatedAt': return store.iso(repo.seq);
        case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}`;
        case 'issue': {
          const item = typeof args.number === 'number' ? store.findItem(repo, args.number) : undefined;
          return item && item.kind === 'issue' ? sub({ type: 'Issue', repo, item }, 'Issue', field, ctx) : null;
        }
        case 'issues': return sub(issueConnection(repo, args), 'IssueConnection', field, ctx);
        case 'pullRequest': {
          const item = typeof args.number === 'number' ? store.findItem(repo, args.number) : undefined;
          return item && item.kind === 'pr' ? sub({ type: 'PullRequest', repo, item }, 'PullRequest', field, ctx) : null;
        }
        case 'pullRequests': {
          let items = repo.items.filter((item) => item.kind === 'pr');
          const states = Array.isArray(args.states) && args.states.length > 0 ? args.states.map((s) => String(s)) : ['OPEN'];
          items = items.filter((item) => {
            const state = item.merged ? 'MERGED' : item.state === 'open' ? 'OPEN' : 'CLOSED';
            return states.includes(state);
          });
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 25;
          const nodes: Source[] = items.slice(0, first).map((item): Source => ({ type: 'PullRequest', repo, item }));
          const conn: Source = { type: 'Connection', nodes, hasNextPage: false, endCursor: null };
          (conn as { type: string }).type = 'PullRequestConnection';
          return sub(conn, 'PullRequestConnection', field, ctx);
        }
      }
      break;
    }
    case 'Ref': {
      const ref = source as { name: string };
      if (name === 'name') return ref.name;
      if (name === 'prefix') return 'refs/heads/';
      if (name === 'id') return globalId('Ref', ref.name);
      break;
    }
    case 'Issue':
    case 'PullRequest': {
      const { repo, item } = source as { repo: RepoRec; item: ItemRec };
      switch (name) {
        case 'id': return globalId(typeName, `${repo.id}:${item.number}`);
        case 'databaseId': return item.id;
        case 'number': return item.number;
        case 'title': return item.title;
        case 'body': return item.body;
        case 'author': return sub({ type: 'User', user: store.userByLogin(item.author) ?? store.viewer }, 'User', field, ctx);
        case 'repository': return sub({ type: 'Repository', repo }, 'Repository', field, ctx);
        case 'createdAt': return store.iso(item.seq);
        case 'updatedAt': return store.iso(item.seq);
        case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}/${typeName === 'Issue' ? 'issues' : 'pull'}/${item.number}`;
      }
      if (typeName === 'Issue') {
        if (name === 'state') return item.state === 'open' ? 'OPEN' : 'CLOSED';
        if (name === 'closed') return item.state === 'closed';
        if (name === 'labels') {
          const nodes: Source[] = item.labels.map((labelName): Source => ({ type: 'Label', repo, name: labelName }));
          const conn: Source = { type: 'Connection', nodes, hasNextPage: false, endCursor: null };
          (conn as { type: string }).type = 'LabelConnection';
          return sub(conn, 'LabelConnection', field, ctx);
        }
        if (name === 'comments') {
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 25;
          const nodes: Source[] = item.comments.slice(0, first).map(
            (comment): Source => ({ type: 'IssueComment', repo, item, comment }),
          );
          const conn: Source = { type: 'Connection', nodes, hasNextPage: false, endCursor: null };
          (conn as { type: string }).type = 'IssueConnection';
          return sub(conn, 'IssueConnection', field, ctx);
        }
      } else {
        if (name === 'state') return item.merged ? 'MERGED' : item.state === 'open' ? 'OPEN' : 'CLOSED';
        if (name === 'merged') return item.merged;
        if (name === 'headRefName') return item.headRef;
        if (name === 'baseRefName') return item.baseRef;
        if (name === 'mergeable') return pullMergeable(repo, item);
        if (name === 'mergedAt') return item.mergedSeq === null ? null : store.iso(item.mergedSeq);
        if (name === 'files') {
          const files = pullFiles(repo, item);
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 25;
          const nodes: Source[] = files.slice(0, first).map((file): Source => ({ type: 'PullRequestChangedFile', path: file.filename }));
          const conn: Source = { type: 'Connection', nodes, hasNextPage: false, endCursor: null };
          (conn as { type: string }).type = 'PullRequestFileConnection';
          return sub(conn, 'PullRequestFileConnection', field, ctx);
        }
        if (name === 'additions' || name === 'deletions' || name === 'changedFiles') {
          const files = pullFiles(repo, item);
          if (name === 'changedFiles') return files.length;
          return files.reduce((sum, file) => sum + (name === 'additions' ? file.additions : file.deletions), 0);
        }
      }
      break;
    }
    case 'IssueComment': {
      const { repo, item, comment } = source as { repo: RepoRec; item: ItemRec; comment: CommentData };
      switch (name) {
        case 'id': return globalId('IssueComment', `${repo.id}:${item.number}:${comment.id}`);
        case 'databaseId': return comment.id;
        case 'body': return comment.body;
        case 'author': return sub({ type: 'User', user: store.userByLogin(comment.author) ?? store.viewer }, 'User', field, ctx);
        case 'createdAt': return store.iso(comment.seq);
        case 'updatedAt': return store.iso(comment.seq);
        case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}/issues/${item.number}#issuecomment-${comment.id}`;
      }
      break;
    }
    case 'Label': {
      const { repo, name: labelName } = source as { repo: RepoRec; name: string };
      const label = repo.labels.get(labelName);
      switch (name) {
        case 'id': return globalId('Label', `${repo.id}:${labelName}`);
        case 'name': return labelName;
        case 'color': return label?.color ?? 'ededed';
        case 'description': return label?.description ?? '';
        case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}/labels`;
      }
      break;
    }
    default: {
      if (CONNECTION_TYPES.has(typeName)) {
        const connection = source as { nodes: Source[]; hasNextPage: boolean; endCursor: string | null };
        if (name === 'nodes') return subList(connection.nodes, field, ctx);
        if (name === 'totalCount') return connection.nodes.length;
        if (name === 'pageInfo') {
          return sub(
            { type: 'PageInfo', hasNextPage: connection.hasNextPage, endCursor: connection.endCursor },
            'PageInfo',
            field,
            ctx,
          );
        }
        if (name === 'edges') return [];
      }
    }
  }

  if (typeName === 'PageInfo') {
    const info = source as { hasNextPage: boolean; endCursor: string | null };
    if (name === 'hasNextPage') return info.hasNextPage;
    if (name === 'hasPreviousPage') return false;
    if (name === 'endCursor') return info.endCursor;
    if (name === 'startCursor') return info.endCursor;
  }
  if (typeName === 'PullRequestChangedFile' && name === 'path') {
    return (source as { path: string }).path;
  }
  if (typeName === '__Type') {
    const typeNameArg = (source as { name: string }).name;
    if (name === 'name') return typeNameArg;
    if (name === 'kind') return ENUM_VALUES[typeNameArg] ? 'ENUM' : 'OBJECT';
    if (name === 'fields') {
      const nodes: Source[] = (OBJECT_FIELDS[typeNameArg] ?? []).map((fieldName): Source => ({ type: '__Field', name: fieldName }));
      return subList(nodes, field, ctx);
    }
    if (name === 'enumValues') {
      const nodes: Source[] = (ENUM_VALUES[typeNameArg] ?? []).map((value): Source => ({ type: '__EnumValue', name: value }));
      return subList(nodes, field, ctx);
    }
    if (name === 'description') return null;
    if (name === 'possibleTypes' || name === 'interfaces' || name === 'inputFields') return [];
    if (name === 'ofType') return null;
  }
  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (name === 'name') return (source as { name: string }).name;
    if (name === 'description') return null;
    if (name === 'isDeprecated') return false;
    if (name === 'deprecationReason') return null;
    if (name === 'args') return [];
    if (name === 'type') return null;
  }
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    const { repo, item } = source as { repo: RepoRec; item: ItemRec };
    if (name === 'issue') return sub({ type: 'Issue', repo, item }, 'Issue', field, ctx);
    if (name === 'clientMutationId') return null;
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    const { repo, item } = source as { repo: RepoRec; item: ItemRec };
    if (name === 'pullRequest') return sub({ type: 'PullRequest', repo, item }, 'PullRequest', field, ctx);
    if (name === 'clientMutationId') return null;
  }
  if (typeName === 'AddCommentPayload') {
    if (name === 'commentEdge') return sub((source as { edge: Source }).edge, 'CommentEdge', field, ctx);
    if (name === 'clientMutationId') return null;
    if (name === 'subject') return null;
  }
  if (typeName === 'CommentEdge') {
    if (name === 'node') {
      const node = (source as { node: Source }).node;
      return sub(node, node.type, field, ctx);
    }
    if (name === 'cursor') return cursorFor(0);
  }

  ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
  return null;
}

function resolveQuery(name: string, args: Record<string, unknown>, field: FieldNode, ctx: ExecCtx): unknown {
  switch (name) {
    case 'viewer':
      return sub({ type: 'User', user: store.viewer }, 'User', field, ctx);
    case 'repository': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.name === 'string' ? args.name : '';
      const repo = store.findRepo(owner, repoName);
      if (!repo || repo.owner !== owner) return null;
      return sub({ type: 'Repository', repo }, 'Repository', field, ctx);
    }
    case 'node': {
      const id = typeof args.id === 'string' ? args.id : '';
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.type === 'Repository') {
        const repo = repoByGlobalId(id);
        return repo ? sub({ type: 'Node', inner: { type: 'Repository', repo } }, 'Node', field, ctx) : null;
      }
      if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
        const found = itemByGlobalId(id, decoded.type === 'Issue' ? 'issue' : 'pr');
        if (!found) return null;
        const inner: Source =
          found.item.kind === 'issue'
            ? { type: 'Issue', repo: found.repo, item: found.item }
            : { type: 'PullRequest', repo: found.repo, item: found.item };
        return sub({ type: 'Node', inner }, 'Node', field, ctx);
      }
      if (decoded.type === 'User') {
        const user = store.userByLogin(decoded.key);
        return user ? sub({ type: 'Node', inner: { type: 'User', user } }, 'Node', field, ctx) : null;
      }
      return null;
    }
    case '__schema':
      return null;
  }
  ctx.errors.push({ message: `Cannot query field "${name}" on type "Query".` });
  return null;
}

function resolveMutation(name: string, args: Record<string, unknown>, field: FieldNode, ctx: ExecCtx): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'createIssue': {
      const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(input.repositoryId) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found' });
        return null;
      }
      const item = store.newItem(repo, 'issue', {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return sub({ type: 'CreateIssuePayload', repo, item }, 'CreateIssuePayload', field, ctx);
    }
    case 'closeIssue': {
      const found = typeof input.issueId === 'string' ? itemByGlobalId(input.issueId, 'issue') : null;
      if (!found) {
        ctx.errors.push({ message: 'Issue not found' });
        return null;
      }
      found.item.state = 'closed';
      return sub({ type: 'CloseIssuePayload', repo: found.repo, item: found.item }, 'CloseIssuePayload', field, ctx);
    }
    case 'createPullRequest': {
      const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(input.repositoryId) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found' });
        return null;
      }
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha) {
        ctx.errors.push({ message: 'Head or base branch not found' });
        return null;
      }
      const item = store.newItem(repo, 'pr', {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        headRef,
        baseRef,
        headSha,
        baseSha,
      });
      return sub({ type: 'CreatePullRequestPayload', repo, item }, 'CreatePullRequestPayload', field, ctx);
    }
    case 'mergePullRequest': {
      const found = typeof input.pullRequestId === 'string' ? itemByGlobalId(input.pullRequestId, 'pr') : null;
      if (!found) {
        ctx.errors.push({ message: 'Pull request not found' });
        return null;
      }
      try {
        mergePullRequest(found.repo, found.item, 'squash');
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : 'Merge failed' });
        return null;
      }
      return sub({ type: 'MergePullRequestPayload', repo: found.repo, item: found.item }, 'MergePullRequestPayload', field, ctx);
    }
    case 'addComment': {
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const found = itemByGlobalId(subjectId, 'issue') ?? itemByGlobalId(subjectId, 'pr');
      if (!found) {
        ctx.errors.push({ message: 'Subject not found' });
        return null;
      }
      const comment = store.addComment(found.item, typeof input.body === 'string' ? input.body : '', store.viewer.login);
      const node: Source = { type: 'IssueComment', repo: found.repo, item: found.item, comment };
      const edge: Source = { type: 'CommentEdge', node };
      return sub({ type: 'AddCommentPayload', edge }, 'AddCommentPayload', field, ctx);
    }
  }
  ctx.errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
  return null;
}

// ------------------------------------------------------------------ entry point

interface GqlRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function runOperation(request: GqlRequest): { data: unknown; errors?: GqlError[] } {
  if (typeof request?.query !== 'string') {
    return { data: null, errors: [{ message: 'A query string is required' }] };
  }
  let document: { operations: Operation[]; fragments: Map<string, FragmentDef> };
  try {
    document = new Parser(request.query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const operation =
    document.operations.find((op) => request.operationName === undefined || op.name === request.operationName) ??
    document.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'No operation found' }] };
  const ctx: ExecCtx = { vars: request.variables ?? {}, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const out: Record<string, unknown> = {};
  for (const field of flattenSelection(operation.selection, ctx, rootType)) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = rootType;
      continue;
    }
    const args = argsOf(field, ctx);
    if (field.name === '__type') {
      const typeNameArg = typeof args.name === 'string' ? args.name : '';
      out[key] =
        OBJECT_FIELDS[typeNameArg] || ENUM_VALUES[typeNameArg]
          ? sub({ type: '__Type', name: typeNameArg }, '__Type', field, ctx)
          : null;
      continue;
    }
    const known = OBJECT_FIELDS[rootType] ?? [];
    if (!known.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${rootType}".` });
      out[key] = null;
      continue;
    }
    out[key] = rootType === 'Query' ? resolveQuery(field.name, args, field, ctx) : resolveMutation(field.name, args, field, ctx);
  }
  const result: { data: unknown; errors?: GqlError[] } = { data: out };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Serve POST /api/graphql (single or batched operations). Auth is the caller's job. */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await guard(res, async () => {
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((entry) => runOperation(entry as GqlRequest));
      sendJson(res, 200, results);
      return;
    }
    sendJson(res, 200, runOperation(parsed as GqlRequest));
  });
}
