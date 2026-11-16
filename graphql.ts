// GitHub GraphQL v4, for the documents gh and github-mcp-server actually send
// (kit program/env/src/checks-graphql.ts lists them). A small hand-rolled
// parser + executor over the same store as REST; no GraphQL library.
//
// Supported: viewer, repository(owner:, name:), node(id:), __type(name:),
// Issue/PullRequest/Repository fields and connections, the five mutations,
// inline fragments, variables, inline enums/input objects, null variables,
// operation names and batched arrays. An unknown field is a 200 with an
// errors array naming it; an unknown repository is data.repository = null
// with no errors; no token is a 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  store, VIEWER, TRIAL_NOW_ISO, nextDbId, nextSeq, globalId, parseGlobalId,
  type Repo, type Issue, type PullRequest,
} from './store.ts';
import { pullFiles, doMergePullRequest, computeMergeable } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// document parsing
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string;
  args: Record<string, ValueNode>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

class GraphQLParseError extends Error {}

class Lexer {
  #src: string;
  #pos = 0;
  constructor(src: string) {
    this.#src = src;
  }
  #skipIgnored(): void {
    for (;;) {
      while (this.#pos < this.#src.length && /[\s,]/.test(this.#src[this.#pos]!)) this.#pos += 1;
      if (this.#src[this.#pos] === '#') {
        while (this.#pos < this.#src.length && this.#src[this.#pos] !== '\n') this.#pos += 1;
        continue;
      }
      break;
    }
  }
  peek(): string | null {
    this.#skipIgnored();
    if (this.#pos >= this.#src.length) return null;
    return this.#src[this.#pos]!;
  }
  nextName(): string {
    this.#skipIgnored();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.#src.slice(this.#pos));
    if (match === null) throw new GraphQLParseError(`expected a name at ${this.#pos}`);
    this.#pos += match[0].length;
    return match[0];
  }
  nextString(): string {
    this.#skipIgnored();
    if (this.#src[this.#pos] !== '"') throw new GraphQLParseError(`expected a string at ${this.#pos}`);
    this.#pos += 1;
    let out = '';
    for (;;) {
      if (this.#pos >= this.#src.length) throw new GraphQLParseError('unterminated string');
      const ch = this.#src[this.#pos]!;
      if (ch === '"') {
        this.#pos += 1;
        return out;
      }
      if (ch === '\\') {
        const esc = this.#src[this.#pos + 1]!;
        this.#pos += 2;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === '"') out += '"';
        else if (esc === '\\') out += '\\';
        else if (esc === '/') out += '/';
        else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else if (esc === 'u') {
          out += String.fromCharCode(parseInt(this.#src.slice(this.#pos, this.#pos + 4), 16));
          this.#pos += 4;
        } else out += esc;
        continue;
      }
      out += ch;
      this.#pos += 1;
    }
  }
  nextNumber(): { int: boolean; value: number } {
    this.#skipIgnored();
    const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.#src.slice(this.#pos));
    if (match === null) throw new GraphQLParseError(`expected a number at ${this.#pos}`);
    this.#pos += match[0].length;
    const isFloat = match[1] !== undefined || match[2] !== undefined;
    return { int: !isFloat, value: Number(match[0]) };
  }
  expect(ch: string): void {
    this.#skipIgnored();
    if (this.#src[this.#pos] !== ch) throw new GraphQLParseError(`expected ${JSON.stringify(ch)} at ${this.#pos}`);
    this.#pos += 1;
  }
  tryExpect(ch: string): boolean {
    this.#skipIgnored();
    if (this.#src[this.#pos] === ch) {
      this.#pos += 1;
      return true;
    }
    return false;
  }
  atEnd(): boolean {
    this.#skipIgnored();
    return this.#pos >= this.#src.length;
  }
}

function parseValue(lexer: Lexer): ValueNode {
  const ch = lexer.peek();
  if (ch === '$') {
    lexer.expect('$');
    return { kind: 'variable', name: lexer.nextName() };
  }
  if (ch === '"') return { kind: 'string', value: lexer.nextString() };
  if (ch === '[') {
    lexer.expect('[');
    const items: ValueNode[] = [];
    while (!lexer.tryExpect(']')) items.push(parseValue(lexer));
    return { kind: 'list', items };
  }
  if (ch === '{') {
    lexer.expect('{');
    const fields: Record<string, ValueNode> = {};
    while (!lexer.tryExpect('}')) {
      const name = lexer.nextName();
      lexer.expect(':');
      fields[name] = parseValue(lexer);
    }
    return { kind: 'object', fields };
  }
  if (ch === '-' || (ch !== null && ch >= '0' && ch <= '9')) {
    const num = lexer.nextNumber();
    return num.int ? { kind: 'int', value: num.value } : { kind: 'float', value: num.value };
  }
  const name = lexer.nextName();
  if (name === 'true') return { kind: 'boolean', value: true };
  if (name === 'false') return { kind: 'boolean', value: false };
  if (name === 'null') return { kind: 'null' };
  return { kind: 'enum', value: name };
}

function parseArguments(lexer: Lexer): Record<string, ValueNode> {
  const args: Record<string, ValueNode> = {};
  if (!lexer.tryExpect('(')) return args;
  while (!lexer.tryExpect(')')) {
    const name = lexer.nextName();
    lexer.expect(':');
    args[name] = parseValue(lexer);
  }
  return args;
}

function parseSelections(lexer: Lexer): SelectionNode[] {
  lexer.expect('{');
  const selections: SelectionNode[] = [];
  while (!lexer.tryExpect('}')) {
    if (lexer.peek() === '.') {
      lexer.expect('.');
      lexer.expect('.');
      lexer.expect('.');
      const name = lexer.nextName();
      if (name === 'on') {
        const typeCondition = lexer.nextName();
        selections.push({ kind: 'fragment', typeCondition, selections: parseSelections(lexer) });
      } else {
        selections.push({ kind: 'fragment', typeCondition: null, selections: [] });
        // Named fragment spread: the fragment definition is resolved later;
        // store the name in typeCondition for the executor.
        const last = selections[selections.length - 1] as FragmentNode;
        (last as unknown as { spreadName: string }).spreadName = name;
      }
      continue;
    }
    const first = lexer.nextName();
    let alias = first;
    let name = first;
    if (lexer.tryExpect(':')) {
      name = lexer.nextName();
    }
    const args = parseArguments(lexer);
    const sub = lexer.peek() === '{' ? parseSelections(lexer) : [];
    selections.push({ kind: 'field', name, alias, args, selections: sub });
  }
  return selections;
}

function parseType(lexer: Lexer): string {
  let type: string;
  if (lexer.tryExpect('[')) {
    type = `[${parseType(lexer)}]`;
    lexer.expect(']');
  } else {
    type = lexer.nextName();
  }
  if (lexer.tryExpect('!')) type += '!';
  return type;
}

function parseDocument(src: string): { operations: OperationNode[]; fragments: Map<string, FragmentDef> } {
  const lexer = new Lexer(src);
  const operations: OperationNode[] = [];
  const fragments = new Map<string, FragmentDef>();
  while (!lexer.atEnd()) {
    // Shorthand anonymous query: the document opens with a selection set.
    if (lexer.peek() === '{') {
      operations.push({ kind: 'query', name: null, selections: parseSelections(lexer) });
      continue;
    }
    const keyword = lexer.nextName();
    if (keyword === 'fragment') {
      const name = lexer.nextName();
      const on = lexer.nextName();
      if (on !== 'on') throw new GraphQLParseError('expected "on" in a fragment definition');
      const typeCondition = lexer.nextName();
      fragments.set(name, { name, typeCondition, selections: parseSelections(lexer) });
      continue;
    }
    let kind: 'query' | 'mutation' = 'query';
    if (keyword === 'query' || keyword === 'mutation') kind = keyword;
    else if (keyword === 'subscription') throw new GraphQLParseError('subscriptions are not supported');
    else throw new GraphQLParseError(`unexpected keyword ${keyword}`);
    let name: string | null = null;
    if (lexer.peek() !== '(' && lexer.peek() !== '{') name = lexer.nextName();
    if (lexer.tryExpect('(')) {
      // Variable definitions: $name: Type (= default)? — parsed, not validated.
      while (!lexer.tryExpect(')')) {
        lexer.expect('$');
        lexer.nextName();
        lexer.expect(':');
        parseType(lexer);
        if (lexer.tryExpect('=')) parseValue(lexer);
      }
    }
    operations.push({ kind, name, selections: parseSelections(lexer) });
  }
  return { operations, fragments };
}

// ---------------------------------------------------------------------------------------------
// schema (introspection answers + field validation)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt',
    'updatedAt', 'url', 'isPrivate', 'fork',
  ],
  Ref: ['name', 'prefix', 'branchName'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'commits', 'author', 'createdAt', 'updatedAt', 'closedAt',
    'mergedAt', 'mergeCommit', 'url',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['COMMIT', 'DISCUSSION', 'ISSUE', 'MILESTONE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'TRIAGE', 'READ', 'WRITE'],
};

const TYPE_KIND: Record<string, 'OBJECT' | 'ENUM' | 'INTERFACE'> = {
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  RepositoryPermission: 'ENUM',
  Node: 'INTERFACE',
};

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface ExecContext {
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: (string | number)[] }>;
  fragments: Map<string, FragmentDef>;
}

type AnyRecord = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: AnyRecord = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, ctx: ExecContext): AnyRecord {
  const out: AnyRecord = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveValue(value, ctx.variables);
  return out;
}

function typeNameOf(value: unknown): string {
  if (value === null || typeof value !== 'object') return '';
  const record = value as AnyRecord;
  return typeof record.__typename === 'string' ? record.__typename : '';
}

function executeSelections(
  selections: SelectionNode[],
  parent: unknown,
  parentType: string,
  ctx: ExecContext,
  path: (string | number)[],
): AnyRecord {
  const out: AnyRecord = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const spreadName = (selection as unknown as { spreadName?: string }).spreadName;
      if (spreadName !== undefined) {
        const def = ctx.fragments.get(spreadName);
        if (def !== undefined) {
          Object.assign(out, executeSelections(def.selections, parent, parentType, ctx, path));
        }
        continue;
      }
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(selection.selections, parent, parentType, ctx, path));
      continue;
    }
    const field = selection;
    const fieldType = TYPE_FIELDS[parentType];
    if (field.name === '__typename') {
      out[field.alias] = parentType;
      continue;
    }
    if (fieldType === undefined || !fieldType.includes(field.name)) {
      ctx.errors.push({
        message: `Cannot query field "${field.name}" on type "${parentType}".`,
        path: [...path, field.alias],
      });
      out[field.alias] = null;
      continue;
    }
    const value = resolveField(field, parent, parentType, ctx, [...path, field.alias]);
    out[field.alias] = value;
  }
  return out;
}

function connectionResult<T>(items: readonly T[], first: number | undefined, after: string | undefined): { nodes: T[]; pageInfo: AnyRecord } {
  let start = 0;
  if (after !== undefined && after !== null && after !== '') {
    try {
      const text = Buffer.from(String(after), 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(text);
      if (match !== null) {
        const seq = Number(match[1]);
        const index = items.findIndex((item) => (item as AnyRecord).__seq === seq);
        if (index >= 0) start = index + 1;
      }
    } catch {
      // An unparseable cursor restarts from the beginning.
    }
  }
  const page = first === undefined ? items.slice(start) : items.slice(start, start + first);
  const endCursor = page.length > 0 ? Buffer.from(`cursor:${(page[page.length - 1] as AnyRecord).__seq}`).toString('base64') : null;
  return {
    nodes: page,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: first !== undefined && start + first < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? Buffer.from(`cursor:${(page[0] as AnyRecord).__seq}`).toString('base64') : null,
      endCursor,
    },
  };
}

function issueNode(issue: Issue, repo: Repo): AnyRecord {
  return {
    __typename: 'Issue',
    __seq: issue.seq,
    id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.state === 'closed' ? issue.updatedAt : null,
    author: { __typename: 'User', login: VIEWER.login },
    labels: { nodes: issue.labels.map((label) => ({ name: label.name })) },
    comments: { nodes: issue.comments.map((comment) => ({ id: globalId('IssueComment', comment.id), body: comment.body })) },
    url: '',
    _repo: repo,
    _issue: issue,
  };
}

function pullNode(pull: PullRequest, repo: Repo): AnyRecord {
  return {
    __typename: 'PullRequest',
    __seq: pull.seq,
    id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: pull.merged ? 'MERGEABLE' : computeMergeable(repo, pull),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRef: { __typename: 'Ref', name: pull.headRef },
    baseRef: { __typename: 'Ref', name: pull.baseRef },
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.state === 'closed' ? pull.updatedAt : null,
    mergedAt: pull.mergedAt,
    url: '',
    _repo: repo,
    _pull: pull,
  };
}

function repoNode(repo: Repo): AnyRecord {
  return {
    __typename: 'Repository',
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0 },
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`)
      ? { __typename: 'Ref', name: repo.defaultBranch }
      : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    url: '',
    isPrivate: repo.private,
    fork: false,
    _repo: repo,
  };
}

function resolveField(
  field: FieldNode,
  parent: unknown,
  parentType: string,
  ctx: ExecContext,
  path: (string | number)[],
): unknown {
  const args = resolveArgs(field, ctx);
  const record = (parent ?? {}) as AnyRecord;

  if (parentType === 'Query') {
    if (field.name === 'viewer') {
      const node: AnyRecord = { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, url: '' };
      return executeSelections(field.selections, node, 'User', ctx, path);
    }
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = store.getRepo(owner, name);
      if (repo === undefined || owner.toLowerCase() !== VIEWER.login.toLowerCase()) return null;
      return executeSelections(field.selections, repoNode(repo), 'Repository', ctx, path);
    }
    if (field.name === 'node') {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (parsed === null) return null;
      const found = store.findByDbId(parsed.dbId);
      if (found === null || found.kind !== parsed.kind) return null;
      if (found.kind === 'Repository' && found.repo !== undefined) {
        return executeSelections(field.selections, repoNode(found.repo), 'Repository', ctx, path);
      }
      if (found.kind === 'Issue' && found.repo !== undefined && found.issue !== undefined) {
        return executeSelections(field.selections, issueNode(found.issue, found.repo), 'Issue', ctx, path);
      }
      if (found.kind === 'PullRequest' && found.repo !== undefined && found.pull !== undefined) {
        return executeSelections(field.selections, pullNode(found.pull, found.repo), 'PullRequest', ctx, path);
      }
      if (found.kind === 'IssueComment' && found.repo !== undefined && found.issue !== undefined && found.comment !== undefined) {
        const node: AnyRecord = {
          __typename: 'IssueComment',
          id: globalId('IssueComment', found.comment.id),
          body: found.comment.body,
          createdAt: found.comment.createdAt,
          updatedAt: found.comment.updatedAt,
        };
        return executeSelections(field.selections, node, 'IssueComment', ctx, path);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      const fields = TYPE_FIELDS[name];
      const enumValues = TYPE_ENUM_VALUES[name];
      if (fields === undefined && enumValues === undefined) return null;
      const node: AnyRecord = {
        __typename: '__Type',
        name,
        kind: TYPE_KIND[name] ?? (enumValues !== undefined ? 'ENUM' : 'OBJECT'),
        _fields: fields ?? null,
        _enumValues: enumValues ?? null,
      };
      return executeSelections(field.selections, node, '__Type', ctx, path);
    }
    return null;
  }

  if (parentType === '__Type') {
    if (field.name === 'fields') {
      const fields = record._fields as string[] | null;
      if (fields === null) return null;
      return fields.map((name) => ({ __typename: '__Field', name }));
    }
    if (field.name === 'enumValues') {
      const values = record._enumValues as string[] | null;
      if (values === null) return null;
      return values.map((name) => ({ __typename: '__EnumValue', name }));
    }
    return record[field.name] ?? null;
  }

  if (parentType === 'Repository') {
    const repo = record._repo as Repo;
    if (field.name === 'issue') {
      const issue = repo.issues.find((candidate) => candidate.number === Number(args.number));
      if (issue === undefined) return null;
      return executeSelections(field.selections, issueNode(issue, repo), 'Issue', ctx, path);
    }
    if (field.name === 'issues') {
      let issues = [...repo.issues];
      const states = args.states as string[] | undefined;
      if (states !== undefined) {
        const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      if (orderBy?.field === 'CREATED_AT') {
        issues.sort((a, b) => (orderBy.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
      } else {
        issues.sort((a, b) => a.seq - b.seq);
      }
      const first = args.first === undefined ? undefined : Number(args.first);
      const after = args.after === undefined ? undefined : (args.after as string | null);
      const page = connectionResult(issues.map((issue) => issueNode(issue, repo)), first, after ?? undefined);
      const node: AnyRecord = {
        __typename: 'IssueConnection',
        nodes: page.nodes,
        pageInfo: page.pageInfo,
        totalCount: issues.length,
      };
      return executeSelections(field.selections, node, 'IssueConnection', ctx, path);
    }
    if (field.name === 'pullRequests') {
      const pulls = repo.pulls.filter((pull) => pull.state === 'open').sort((a, b) => a.number - b.number);
      const first = args.first === undefined ? undefined : Number(args.first);
      const after = args.after === undefined ? undefined : (args.after as string | null);
      const page = connectionResult(pulls.map((pull) => pullNode(pull, repo)), first, after ?? undefined);
      const node: AnyRecord = {
        __typename: 'PullRequestConnection',
        nodes: page.nodes,
        pageInfo: page.pageInfo,
        totalCount: pulls.length,
      };
      return executeSelections(field.selections, node, 'PullRequestConnection', ctx, path);
    }
    if (field.name === 'pullRequest') {
      const pull = repo.pulls.find((candidate) => candidate.number === Number(args.number));
      if (pull === undefined) return null;
      return executeSelections(field.selections, pullNode(pull, repo), 'PullRequest', ctx, path);
    }
    if (field.name === 'owner') {
      const owner = record.owner as AnyRecord;
      return executeSelections(field.selections, owner, 'User', ctx, path);
    }
    if (field.name === 'defaultBranchRef') {
      const ref = record.defaultBranchRef as AnyRecord | null;
      if (ref === null) return null;
      return executeSelections(field.selections, ref, 'Ref', ctx, path);
    }
    return record[field.name] ?? null;
  }

  if (parentType === 'PullRequest') {
    const pull = record._pull as PullRequest;
    const repo = record._repo as Repo;
    if (field.name === 'files') {
      const files = pullFiles(repo, pull);
      const first = args.first === undefined ? undefined : Number(args.first);
      const nodes = files.slice(0, first).map((file, index) => ({
        __typename: 'PullRequestChangedFile',
        __seq: index + 1,
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: String(file.status ?? '').toUpperCase(),
      }));
      const node: AnyRecord = {
        __typename: 'PullRequestChangedFileConnection',
        nodes,
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: files.length,
      };
      return executeSelections(field.selections, node, 'PullRequestChangedFileConnection', ctx, path);
    }
    return record[field.name] ?? null;
  }

  if (parentType === 'IssueConnection' || parentType === 'PullRequestConnection' || parentType === 'PullRequestChangedFileConnection') {
    if (field.name === 'nodes') {
      const nodes = record.nodes as AnyRecord[];
      const itemType = parentType === 'IssueConnection' ? 'Issue' : parentType === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
      return nodes.map((node) => executeSelections(field.selections, node, itemType, ctx, path));
    }
    if (field.name === 'edges') {
      const nodes = record.nodes as AnyRecord[];
      const itemType = parentType === 'IssueConnection' ? 'Issue' : parentType === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
      return nodes.map((node) => executeSelections(field.selections, { __typename: 'IssueEdge', node, cursor: null }, 'IssueEdge', ctx, path));
    }
    if (field.name === 'pageInfo') {
      return executeSelections(field.selections, record.pageInfo as AnyRecord, 'PageInfo', ctx, path);
    }
    return record[field.name] ?? null;
  }

  if (parentType === 'IssueEdge') {
    if (field.name === 'node') {
      const node = record.node as AnyRecord;
      const itemType = typeNameOf(node);
      return executeSelections(field.selections, node, itemType, ctx, path);
    }
    return record[field.name] ?? null;
  }

  if (parentType === 'Mutation') {
    return resolveMutation(field, ctx, path);
  }

  // Leaf types (User, Ref, Issue, PageInfo, __Field, __EnumValue, ...).
  // If the value is a node with sub-selections, execute them against it.
  const value = record[field.name] ?? null;
  if (value !== null && typeof value === 'object' && field.selections.length > 0) {
    const itemType = typeNameOf(value);
    if (itemType !== '') {
      return executeSelections(field.selections, value, itemType, ctx, path);
    }
  }
  return value;
}

function resolveMutation(field: FieldNode, ctx: ExecContext, path: (string | number)[]): unknown {
  const args = resolveArgs(field, ctx);
  const input = (args.input ?? {}) as AnyRecord;

  if (field.name === 'createIssue') {
    const parsed = parseGlobalId(String(input.repositoryId ?? ''));
    const found = parsed === null ? null : store.findByDbId(parsed.dbId);
    if (found === null || found.kind !== 'Repository' || found.repo === undefined) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.', path });
      return null;
    }
    const repo = found.repo;
    const title = String(input.title ?? '');
    const issue: Issue = {
      id: nextDbId(),
      number: repo.nextIssueNumber,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      seq: nextSeq(),
      createdAt: TRIAL_NOW_ISO,
      updatedAt: TRIAL_NOW_ISO,
      comments: [],
    };
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    const payload: AnyRecord = {
      __typename: 'CreateIssuePayload',
      issue: issueNode(issue, repo),
    };
    return executeSelections(field.selections, payload, 'CreateIssuePayload', ctx, path);
  }

  if (field.name === 'closeIssue') {
    const parsed = parseGlobalId(String(input.issueId ?? ''));
    const found = parsed === null ? null : store.findByDbId(parsed.dbId);
    if (found === null || found.kind !== 'Issue' || found.repo === undefined || found.issue === undefined) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.', path });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.updatedAt = TRIAL_NOW_ISO;
    const payload: AnyRecord = {
      __typename: 'CloseIssuePayload',
      issue: issueNode(found.issue, found.repo),
    };
    return executeSelections(field.selections, payload, 'CloseIssuePayload', ctx, path);
  }

  if (field.name === 'createPullRequest') {
    const parsed = parseGlobalId(String(input.repositoryId ?? ''));
    const found = parsed === null ? null : store.findByDbId(parsed.dbId);
    if (found === null || found.kind !== 'Repository' || found.repo === undefined) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.', path });
      return null;
    }
    const repo = found.repo;
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) {
      ctx.errors.push({ message: 'Head or base ref does not exist.', path });
      return null;
    }
    const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
    if (existing !== undefined) {
      ctx.errors.push({ message: 'A pull request already exists for this branch.', path });
      return null;
    }
    const pull: PullRequest = {
      id: nextDbId(),
      number: repo.nextPullNumber,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      seq: nextSeq(),
      createdAt: TRIAL_NOW_ISO,
      updatedAt: TRIAL_NOW_ISO,
    };
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    const payload: AnyRecord = {
      __typename: 'CreatePullRequestPayload',
      pullRequest: pullNode(pull, repo),
    };
    return executeSelections(field.selections, payload, 'CreatePullRequestPayload', ctx, path);
  }

  if (field.name === 'mergePullRequest') {
    const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
    const found = parsed === null ? null : store.findByDbId(parsed.dbId);
    if (found === null || found.kind !== 'PullRequest' || found.repo === undefined || found.pull === undefined) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.', path });
      return null;
    }
    const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
    const result = doMergePullRequest(found.repo, found.pull, method === 'merge' ? 'merge' : 'squash');
    if (!result.ok) {
      ctx.errors.push({ message: result.message, path });
      return null;
    }
    const payload: AnyRecord = {
      __typename: 'MergePullRequestPayload',
      pullRequest: pullNode(found.pull, found.repo),
    };
    return executeSelections(field.selections, payload, 'MergePullRequestPayload', ctx, path);
  }

  if (field.name === 'addComment') {
    const parsed = parseGlobalId(String(input.subjectId ?? ''));
    const found = parsed === null ? null : store.findByDbId(parsed.dbId);
    if (found === null || found.kind !== 'Issue' || found.repo === undefined || found.issue === undefined) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.', path });
      return null;
    }
    const comment = {
      id: nextDbId(),
      body: String(input.body ?? ''),
      seq: nextSeq(),
      createdAt: TRIAL_NOW_ISO,
      updatedAt: TRIAL_NOW_ISO,
    };
    found.issue.comments.push(comment);
    const node: AnyRecord = {
      __typename: 'IssueComment',
      id: globalId('IssueComment', comment.id),
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    };
    const payload: AnyRecord = {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'IssueCommentEdge', node, cursor: null },
      comment: node,
    };
    return executeSelections(field.selections, payload, 'AddCommentPayload', ctx, path);
  }

  ctx.errors.push({ message: `Unknown mutation "${field.name}".`, path });
  return null;
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLDeps {
  token: string;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function executeOperation(body: { query?: unknown; variables?: unknown; operationName?: unknown }): AnyRecord {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (body.variables !== null && typeof body.variables === 'object' && !Array.isArray(body.variables)
    ? body.variables
    : {}) as Record<string, unknown>;
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  try {
    const { operations, fragments } = parseDocument(query);
    let operation = operations[0] ?? null;
    if (operationName !== null) {
      operation = operations.find((candidate) => candidate.name === operationName) ?? null;
    }
    if (operation === null) {
      return { errors: [{ message: 'No operation to execute.' }] };
    }
    const ctx: ExecContext = { variables, errors: [], fragments };
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelections(operation.selections, {}, rootType, ctx, []);
    const out: AnyRecord = { data };
    if (ctx.errors.length > 0) out.errors = ctx.errors;
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, errors: [{ message }] };
  }
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, deps: GraphQLDeps): Promise<boolean> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ message: 'Method not allowed' }] }));
    return true;
  }
  if (deps.token !== '') {
    const header = req.headers.authorization ?? '';
    if (header !== `Bearer ${deps.token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Requires authentication' }));
      return true;
    }
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ message: 'Could not read request body' }] }));
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ message: 'Request body is not valid JSON' }] }));
    return true;
  }
  let result: unknown;
  if (Array.isArray(parsed)) {
    result = parsed.map((entry) =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? executeOperation(entry as { query?: unknown; variables?: unknown; operationName?: unknown })
        : { errors: [{ message: 'Invalid operation' }] },
    );
  } else if (parsed !== null && typeof parsed === 'object') {
    result = executeOperation(parsed as { query?: unknown; variables?: unknown; operationName?: unknown });
  } else {
    result = { errors: [{ message: 'Invalid request body' }] };
  }
  const text = JSON.stringify(result);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) });
  res.end(text);
  return true;
}
