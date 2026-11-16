// GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, over the in-memory store. Every reply is JSON
// with a non-empty X-GitHub-Request-Id; errors are {"message": string}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  store, VIEWER, TRIAL_NOW_ISO, TRIAL_NOW_SEC, nextDbId, nextSeq, globalId,
  type Repo, type Issue, type Label, type PullRequest,
} from './store.ts';
import {
  ZERO_OID, hashObject, parseCommit, parseTag, parseTree, buildTree,
  buildCommit, forgeIdentity, flattenTree, buildTreeFromFiles, threeWayMerge,
  mergeBase, reachableCommits, collectReachable,
} from './gitproto.ts';

export interface RestDeps {
  token: string;
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
}

function sendJson(ctx: Ctx, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = status === 204 ? '' : JSON.stringify(body);
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...(status === 204 ? {} : { 'content-length': String(Buffer.byteLength(text)) }),
    ...extraHeaders,
  });
  ctx.res.end(text);
}

function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

function baseUrlOf(ctx: Ctx): string {
  const host = ctx.req.headers.host ?? 'localhost';
  return `http://${host}`;
}

function pageParams(ctx: Ctx): { page: number; perPage: number } {
  const page = Math.max(1, Number(ctx.url.searchParams.get('page') ?? '1') || 1);
  const perPageRaw = Number(ctx.url.searchParams.get('per_page') ?? '30') || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}

function paginate<T>(ctx: Ctx, items: readonly T[], total: number): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(ctx);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return { page: slice, link: null };
  const base = `${baseUrlOf(ctx)}${ctx.url.pathname}`;
  const query = new URLSearchParams(ctx.url.searchParams);
  const links: string[] = [];
  if (page < totalPages) {
    query.set('page', String(page + 1));
    links.push(`<${base}?${query.toString()}>; rel="next"`);
    query.set('page', String(totalPages));
    links.push(`<${base}?${query.toString()}>; rel="last"`);
  }
  if (page > 1) {
    query.set('page', String(1));
    links.push(`<${base}?${query.toString()}>; rel="first"`);
    query.set('page', String(page - 1));
    links.push(`<${base}?${query.toString()}>; rel="prev"`);
  }
  return { page: slice, link: links.join(', ') };
}

function sendPage<T>(ctx: Ctx, items: readonly T[]): void {
  const { page, link } = paginate(ctx, items, items.length);
  sendJson(ctx, 200, page, link === null ? {} : { link });
}

// ---------------------------------------------------------------------------------------------
// JSON views
// ---------------------------------------------------------------------------------------------

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, node_id: globalId('User', id), avatar_url: '', type: 'User', site_admin: false };
}

function repoJson(base: string, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, VIEWER.id),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    html_url: `${base}/${repo.owner}/${repo.name}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    git_url: `${base}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    license: null,
    topics: [],
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueJson(base: string, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(VIEWER.login, VIEWER.id),
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function commentJson(base: string, repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    issue_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function computeMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
  // Mergeability is against the base branch's current tip, for the same
  // reason as doMergePullRequest: a merged sibling PR moves the base.
  const currentBaseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const base = mergeBase(currentBaseSha, pull.headSha, (oid) => repo.objects.get(oid));
  if (base === null) return 'CONFLICTING';
  const baseObj = repo.objects.get(base);
  const headObj = repo.objects.get(pull.headSha);
  const baseTipObj = repo.objects.get(currentBaseSha);
  if (baseObj === undefined || headObj === undefined || baseTipObj === undefined) return 'CONFLICTING';
  if (baseObj.type !== 'commit' || headObj.type !== 'commit' || baseTipObj.type !== 'commit') return 'CONFLICTING';
  const baseTree = flattenTree(parseCommit(baseObj.data).tree, (oid) => repo.objects.get(oid));
  const oursTree = flattenTree(parseCommit(baseTipObj.data).tree, (oid) => repo.objects.get(oid));
  const theirsTree = flattenTree(parseCommit(headObj.data).tree, (oid) => repo.objects.get(oid));
  return threeWayMerge(baseTree, oursTree, theirsTree) === null ? 'CONFLICTING' : 'MERGEABLE';
}

function pullJson(base: string, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const mergeable = pull.merged ? 'MERGEABLE' : computeMergeable(repo, pull);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    mergeable: mergeable === 'MERGEABLE',
    mergeable_state: mergeable === 'MERGEABLE' ? 'clean' : 'dirty',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merge_method: 'squash',
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: userJson(repo.owner, VIEWER.id),
      repo: repoJson(base, repo),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: userJson(repo.owner, VIEWER.id),
      repo: repoJson(base, repo),
    },
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(ctx: Ctx, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  const parseIdentity = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: line, email: '', date: TRIAL_NOW_ISO };
    return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  const base = baseUrlOf(ctx);
  return {
    sha,
    node_id: globalId('Commit', nextDbIdForCommit(sha)),
    commit: {
      // GitHub returns the message without the trailing newline the object
      // stores; the checks compare it exactly.
      message: parsed.message.replace(/\n+$/, ''),
      author: parseIdentity(parsed.author),
      committer: parseIdentity(parsed.committer),
      tree: { sha: parsed.tree },
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
    },
    author: userJson(VIEWER.login, VIEWER.id),
    committer: userJson(VIEWER.login, VIEWER.id),
    parents: parsed.parents.map((parent) => ({ sha: parent })),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

// A stable numeric id for a commit sha (derived, not a counter: commits are
// content-addressed and must keep the same id across reads).
const commitIdCache = new Map<string, number>();
function nextDbIdForCommit(sha: string): number {
  let id = commitIdCache.get(sha);
  if (id === undefined) {
    id = nextDbId();
    commitIdCache.set(sha, id);
  }
  return id;
}

// ---------------------------------------------------------------------------------------------
// git helpers for contents / merges
// ---------------------------------------------------------------------------------------------

function resolveRef(repo: Repo, ref: string): string | null {
  if (ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const object = repo.objects.get(ref);
    if (object !== undefined && object.type === 'commit') return ref;
  }
  return null;
}

function storeGitObject(repo: Repo, type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

interface FileChange {
  treeOid: string;
  newObjects: Array<{ type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>;
}

/** Build a new root tree for `files` (complete map) on top of `baseRootOid`. */
function rebuildTree(
  repo: Repo,
  files: ReadonlyMap<string, { oid: string; mode: string }>,
  baseRootOid: string | null,
): FileChange {
  const lookup = (oid: string) => {
    const found = repo.objects.get(oid);
    if (found !== undefined) return found;
    return pendingObjects.get(oid);
  };
  const pendingObjects = new Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>();
  const { treeOid, newObjects } = buildTreeFromFiles(files, baseRootOid, lookup);
  for (const object of newObjects) {
    const oid = hashObject(object.type, object.data);
    pendingObjects.set(oid, object);
  }
  return { treeOid, newObjects: [...pendingObjects.values()] };
}

function commitOnBranch(
  repo: Repo,
  branch: string,
  treeOid: string,
  message: string,
  parents: readonly string[],
): { commitOid: string; objects: Array<{ type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }> } {
  const identity = forgeIdentity(TRIAL_NOW_SEC);
  const data = buildCommit({ tree: treeOid, parents, author: identity, committer: identity, message });
  const commitOid = hashObject('commit', data);
  return { commitOid, objects: [{ type: 'commit', data }] };
}

function applyObjects(repo: Repo, objects: readonly { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }[]): void {
  for (const object of objects) {
    const oid = hashObject(object.type, object.data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
  }
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && !name.endsWith('.git');
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, deps: RestDeps): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const segments = url.pathname.split('/').filter((part) => part !== '');
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const ctx: Ctx = { req, res, url, segments: segments.slice(2) };
  const method = req.method ?? 'GET';

  // The API root is public (the starter's behaviour); everything else needs
  // the trial token.
  const isRoot = ctx.segments.length === 0;
  if (!isRoot) {
    if (deps.token !== '') {
      const header = req.headers.authorization ?? '';
      if (header !== `Bearer ${deps.token}`) {
        sendError(ctx, 401, 'Requires authentication');
        return true;
      }
    }
  }

  try {
    return await routeRest(ctx, method);
  } catch (err) {
    if (!res.writableEnded) sendError(ctx, 500, err instanceof Error ? err.message : 'Internal server error');
    return true;
  }
}

async function routeRest(ctx: Ctx, method: string): Promise<boolean> {
  const seg = ctx.segments;

  // GET /api/v3/
  if (seg.length === 0) {
    if (method !== 'GET') return false;
    const base = baseUrlOf(ctx);
    sendJson(ctx, 200, {
      current_user_url: `${base}/api/v3/user`,
      current_user_authorizations_html_url: `${base}/settings/applications`,
      authorizations_url: `${base}/api/v3/authorizations`,
      code_search_url: `${base}/api/v3/search/code?q={query}`,
      commit_search_url: `${base}/api/v3/search/commits?q={query}`,
      emails_url: `${base}/api/v3/user/emails`,
      emojis_url: `${base}/api/v3/emojis`,
      events_url: `${base}/api/v3/events`,
      feeds_url: `${base}/api/v3/feeds`,
      followers_url: `${base}/api/v3/user/followers`,
      following_url: `${base}/api/v3/user/following{/target}`,
      gists_url: `${base}/api/v3/gists{/gist_id}`,
      hub_url: `${base}/api/v3/hub`,
      issue_search_url: `${base}/api/v3/search/issues?q={query}`,
      issues_url: `${base}/api/v3/issues`,
      keys_url: `${base}/api/v3/user/keys`,
      label_search_url: `${base}/api/v3/search/labels?q={query}`,
      notifications_url: `${base}/api/v3/notifications`,
      organization_url: `${base}/api/v3/orgs/{org}`,
      public_gists_url: `${base}/api/v3/gists/public`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${base}/api/v3/search/repositories?q={query}`,
      current_user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page,sort}`,
      starred_url: `${base}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${base}/api/v3/gists/starred`,
      topic_search_url: `${base}/api/v3/search/topics?q={query}`,
      user_url: `${base}/api/v3/users/{user}`,
      user_organizations_url: `${base}/api/v3/user/orgs`,
      user_repositories_url: `${base}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${base}/api/v3/search/users?q={query}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/rate_limit
  if (seg.length === 1 && seg[0] === 'rate_limit') {
    if (method !== 'GET') return false;
    sendJson(ctx, 200, {
      resources: { core: { limit: 60, remaining: 59, reset: TRIAL_NOW_SEC + 3600, used: 1 }, graphql: { limit: 60, remaining: 59, reset: TRIAL_NOW_SEC + 3600, used: 1 } },
      rate: { limit: 60, remaining: 59, reset: TRIAL_NOW_SEC + 3600, used: 1 },
    });
    return true;
  }

  // GET /api/v3/meta — the forge's installed version.
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return false;
    sendJson(ctx, 200, { installed_version: '1.0.0' });
    return true;
  }

  // /api/v3/user...
  if (seg[0] === 'user') {
    if (seg.length === 1) {
      if (method !== 'GET') return false;
      const base = baseUrlOf(ctx);
      sendJson(ctx, 200, {
        ...userJson(VIEWER.login, VIEWER.id),
        name: VIEWER.name,
        email: VIEWER.email,
        html_url: `${base}/${VIEWER.login}`,
        url: `${base}/api/v3/user`,
        type: 'User',
        site_admin: false,
        public_repos: store.listReposByOwner(VIEWER.login).length,
        followers: 0,
        following: 0,
        created_at: TRIAL_NOW_ISO,
        updated_at: TRIAL_NOW_ISO,
      });
      return true;
    }
    if (seg.length === 2 && seg[1] === 'repos') {
      if (method === 'GET') {
        sendPage(ctx, store.listReposByOwner(VIEWER.login).map((repo) => repoJson(baseUrlOf(ctx), repo)));
        return true;
      }
      if (method === 'POST') {
        const parsed = await readJsonBody(ctx.req);
        if (!parsed.ok) {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const body = parsed.value;
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '' || !isValidRepoName(name)) {
          sendError(ctx, 422, 'Invalid repository name');
          return true;
        }
        if (store.getRepo(VIEWER.login, name) !== undefined) {
          sendError(ctx, 422, 'Repository already exists');
          return true;
        }
        const repo = store.createRepo(VIEWER.login, name, {
          private: body.private === true,
          description: typeof body.description === 'string' ? body.description : '',
        });
        sendJson(ctx, 201, repoJson(baseUrlOf(ctx), repo));
        return true;
      }
      return false;
    }
    return false;
  }

  // /api/v3/repos/:owner/:repo[/...]
  if (seg[0] === 'repos') {
    if (seg.length < 3) return false;
    const owner = decodeURIComponent(seg[1]!);
    const repoName = decodeURIComponent(seg[2]!);
    const repo = store.getRepo(owner, repoName);
    const rest = seg.slice(3);

    // The repo itself.
    if (rest.length === 0) {
      if (repo === undefined) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        sendJson(ctx, 200, repoJson(baseUrlOf(ctx), repo));
        return true;
      }
      if (method === 'PATCH') {
        const parsed = await readJsonBody(ctx.req);
        if (!parsed.ok) {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
        repo.updatedAt = TRIAL_NOW_ISO;
        sendJson(ctx, 200, repoJson(baseUrlOf(ctx), repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        sendJson(ctx, 204, null);
        return true;
      }
      return false;
    }
    if (repo === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    return await routeRepoSub(ctx, method, repo, rest);
  }

  return false;
}

// ---------------------------------------------------------------------------------------------
// /repos/:owner/:repo/*
// ---------------------------------------------------------------------------------------------

async function routeRepoSub(ctx: Ctx, method: string, repo: Repo, rest: string[]): Promise<boolean> {
  const head = rest[0]!;

  if (head === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return false;
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({
          name,
          commit: { sha: repo.refs.get(`refs/heads/${name}`)!, url: `${baseUrlOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${repo.refs.get(`refs/heads/${name}`)!}` },
          protected: false,
        }));
      sendPage(ctx, branches);
      return true;
    }
    if (rest.length === 2) {
      if (method !== 'GET') return false;
      const name = decodeURIComponent(rest[1]!);
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (sha === undefined) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      sendJson(ctx, 200, {
        name,
        commit: { sha, url: `${baseUrlOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
        protected: false,
      });
      return true;
    }
    return false;
  }

  if (head === 'commits') {
    if (rest.length === 1) {
      if (method !== 'GET') return false;
      const ref = ctx.url.searchParams.get('sha') ?? '';
      const tip = resolveRef(repo, ref);
      if (tip === null) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      const commits = reachableCommits([tip], (oid) => repo.objects.get(oid));
      const views = commits
        .map((sha) => commitJson(ctx, repo, sha))
        .filter((view): view is Record<string, unknown> => view !== null);
      sendPage(ctx, views);
      return true;
    }
    if (rest.length === 2) {
      if (method !== 'GET') return false;
      const sha = decodeURIComponent(rest[1]!);
      const view = commitJson(ctx, repo, sha);
      if (view === null) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      sendJson(ctx, 200, view);
      return true;
    }
    return false;
  }

  if (head === 'git') {
    return await routeGitData(ctx, method, repo, rest.slice(1));
  }

  if (head === 'contents') {
    return await routeContents(ctx, method, repo, rest.slice(1));
  }

  if (head === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') {
        sendPage(ctx, repo.labels.map(labelJson));
        return true;
      }
      if (method === 'POST') {
        const parsed = await readJsonBody(ctx.req);
        if (!parsed.ok) {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
        const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
        if (name === '') {
          sendError(ctx, 422, 'Invalid label name');
          return true;
        }
        if (repo.labels.some((label) => label.name === name)) {
          sendError(ctx, 422, 'Label already exists');
          return true;
        }
        const label: Label = {
          id: nextDbId(),
          name,
          color: color.replace(/^#/, ''),
          description: typeof parsed.value.description === 'string' ? parsed.value.description : '',
          seq: nextSeq(),
        };
        repo.labels.push(label);
        sendJson(ctx, 201, labelJson(label));
        return true;
      }
      return false;
    }
    if (rest.length === 2) {
      const name = decodeURIComponent(rest[1]!);
      const label = repo.labels.find((candidate) => candidate.name === name);
      if (method === 'GET') {
        if (label === undefined) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        sendJson(ctx, 200, labelJson(label));
        return true;
      }
      if (method === 'DELETE') {
        if (label === undefined) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        repo.labels = repo.labels.filter((candidate) => candidate !== label);
        sendJson(ctx, 204, null);
        return true;
      }
      return false;
    }
    return false;
  }

  if (head === 'issues') {
    return await routeIssues(ctx, method, repo, rest.slice(1));
  }

  if (head === 'pulls') {
    return await routePulls(ctx, method, repo, rest.slice(1));
  }

  return false;
}

// ---------------------------------------------------------------------------------------------
// git data API
// ---------------------------------------------------------------------------------------------

async function routeGitData(ctx: Ctx, method: string, repo: Repo, rest: string[]): Promise<boolean> {
  const head = rest[0]!;

  if (head === 'refs') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const refs = sortedRefsList(repo);
        sendPage(ctx, refs);
        return true;
      }
      if (method === 'POST') {
        const parsed = await readJsonBody(ctx.req);
        if (!parsed.ok) {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
        const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
        if (!ref.startsWith('refs/')) {
          sendError(ctx, 422, 'Invalid ref');
          return true;
        }
        if (repo.refs.has(ref)) {
          sendError(ctx, 422, 'Reference already exists');
          return true;
        }
        const object = repo.objects.get(sha);
        if (object === undefined || (object.type !== 'commit' && object.type !== 'tag')) {
          sendError(ctx, 422, 'Object does not exist');
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(ctx, 201, refJson(ctx, repo, ref, sha));
        return true;
      }
      return false;
    }
    if (method === 'GET') {
      const refName = rest.map((part) => decodeURIComponent(part)).join('/');
      const sha = repo.refs.get(refName);
      if (sha === undefined) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      sendJson(ctx, 200, refJson(ctx, repo, refName, sha));
      return true;
    }
    return false;
  }

  if (head === 'commits' && rest.length === 2) {
    if (method !== 'GET') return false;
    const sha = decodeURIComponent(rest[1]!);
    const view = commitJson(ctx, repo, sha);
    if (view === null) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    const object = repo.objects.get(sha)!;
    const parsed = parseCommit(object.data);
    sendJson(ctx, 200, {
      sha,
      node_id: globalId('Commit', nextDbIdForCommit(sha)),
      message: parsed.message,
      tree: { sha: parsed.tree },
      parents: parsed.parents.map((parent) => ({ sha: parent })),
      author: { name: VIEWER.name, email: VIEWER.email, date: TRIAL_NOW_ISO },
      committer: { name: VIEWER.name, email: VIEWER.email, date: TRIAL_NOW_ISO },
      url: `${baseUrlOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
    });
    return true;
  }

  if (head === 'trees' && rest.length === 2) {
    if (method !== 'GET') return false;
    const sha = decodeURIComponent(rest[1]!);
    const recursive = ctx.url.searchParams.get('recursive') === '1';
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'tree') {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    const entries: Array<Record<string, unknown>> = [];
    if (recursive) {
      const flat = flattenTree(sha, (oid) => repo.objects.get(oid));
      for (const [path, file] of [...flat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        entries.push({ path, mode: file.mode, type: 'blob', sha: file.oid, size: repo.objects.get(file.oid)?.data.length ?? 0, url: '' });
      }
      // Include subtree entries too, as GitHub does for recursive trees.
      const walkTrees = (treeOid: string, prefix: string): void => {
        const treeObj = repo.objects.get(treeOid);
        if (treeObj === undefined || treeObj.type !== 'tree') return;
        for (const entry of parseTree(treeObj.data)) {
          const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
          if (entry.mode === '40000') {
            entries.push({ path, mode: entry.mode, type: 'tree', sha: entry.oid, url: '' });
            walkTrees(entry.oid, path);
          }
        }
      };
      walkTrees(sha, '');
      entries.sort((a, b) => String(a.path) < String(b.path) ? -1 : 1);
    } else {
      for (const entry of parseTree(object.data)) {
        entries.push({
          path: entry.name,
          mode: entry.mode,
          type: entry.mode === '40000' ? 'tree' : 'blob',
          sha: entry.oid,
          size: entry.mode === '40000' ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0,
          url: '',
        });
      }
    }
    sendJson(ctx, 200, { sha, tree: entries, truncated: false, url: `${baseUrlOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${sha}` });
    return true;
  }

  if (head === 'blobs' && rest.length === 2) {
    if (method !== 'GET') return false;
    const sha = decodeURIComponent(rest[1]!);
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'blob') {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    sendJson(ctx, 200, {
      sha,
      size: object.data.length,
      content: object.data.toString('base64'),
      encoding: 'base64',
      url: `${baseUrlOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`,
    });
    return true;
  }

  return false;
}

function sortedRefsList(repo: Repo): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, sha] of refs) {
    out.push({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
  }
  return out;
}

function refJson(ctx: Ctx, repo: Repo, ref: string, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  return {
    ref,
    node_id: globalId('Ref', nextDbId()),
    url: `${baseUrlOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.split('/').map(encodeURIComponent).join('/')}`,
    object: { sha, type: object?.type ?? 'commit', url: `${baseUrlOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
  };
}

// ---------------------------------------------------------------------------------------------
// contents API
// ---------------------------------------------------------------------------------------------

async function routeContents(ctx: Ctx, method: string, repo: Repo, rest: string[]): Promise<boolean> {
  const path = rest.map((part) => decodeURIComponent(part)).join('/');
  const refParam = ctx.url.searchParams.get('ref') ?? '';
  const tip = resolveRef(repo, refParam);
  const tipCommit = tip === null ? null : repo.objects.get(tip);
  const rootTree = tipCommit !== null && tipCommit.type === 'commit' ? parseCommit(tipCommit.data).tree : null;

  const lookupPath = (treeOid: string | null): { kind: 'file' | 'dir'; oid: string; mode: string } | null => {
    if (path === '') {
      if (treeOid === null) return null;
      return { kind: 'dir', oid: treeOid, mode: '40000' };
    }
    if (treeOid === null) return null;
    const flat = flattenTree(treeOid, (oid) => repo.objects.get(oid));
    const file = flat.get(path);
    if (file !== undefined) return { kind: 'file', oid: file.oid, mode: file.mode };
    // A directory: any file under path/
    for (const key of flat.keys()) {
      if (key.startsWith(`${path}/`)) {
        // Find the subtree oid by walking the tree.
        let current: string | null = treeOid;
        for (const segment of path.split('/')) {
          const obj = current === null ? undefined : repo.objects.get(current);
          if (obj === undefined || obj.type !== 'tree') { current = null; break; }
          const entry = parseTree(obj.data).find((candidate) => candidate.name === segment);
          if (entry === undefined) { current = null; break; }
          current = entry.oid;
        }
        if (current !== null) return { kind: 'dir', oid: current, mode: '40000' };
        return null;
      }
    }
    return null;
  };

  if (method === 'GET') {
    if (rootTree === null) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    const found = lookupPath(rootTree);
    if (found === null) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    if (found.kind === 'file') {
      const blob = repo.objects.get(found.oid)!;
      sendJson(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: blob.data.toString('base64'),
        sha: found.oid,
        url: `${baseUrlOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      });
      return true;
    }
    const treeObj = repo.objects.get(found.oid)!;
    const entries = parseTree(treeObj.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      size: entry.mode === '40000' ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0,
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      sha: entry.oid,
      url: `${baseUrlOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path === '' ? entry.name : `${path}/${entry.name}`}`,
    }));
    sendJson(ctx, 200, entries);
    return true;
  }

  if (method === 'PUT' || method === 'DELETE') {
    const parsed = await readJsonBody(ctx.req);
    if (!parsed.ok) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return true;
    }
    const body = parsed.value;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `${method === 'PUT' ? 'Update' : 'Delete'} ${path}`;
    let branchTip = repo.refs.get(`refs/heads/${branch}`);
    if (branchTip === undefined) {
      // A write on a new branch starts from the default branch's tip.
      branchTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    const baseTree = branchTip !== undefined ? parseCommit(repo.objects.get(branchTip)!.data).tree : null;
    const flat = baseTree === null ? new Map() : flattenTree(baseTree, (oid) => repo.objects.get(oid));
    const existing = flat.get(path);

    if (method === 'PUT') {
      const contentRaw = typeof body.content === 'string' ? body.content : '';
      let content: Buffer;
      try {
        content = Buffer.from(contentRaw.replace(/\s/g, ''), 'base64');
      } catch {
        sendError(ctx, 422, 'Invalid base64 content');
        return true;
      }
      if (existing !== undefined) {
        if (typeof body.sha !== 'string' || body.sha === '') {
          sendError(ctx, 422, 'file already exists');
          return true;
        }
        if (body.sha !== existing.oid) {
          sendError(ctx, 409, 'sha does not match');
          return true;
        }
      } else if (typeof body.sha === 'string' && body.sha !== '') {
        sendError(ctx, 422, 'sha does not match a file');
        return true;
      }
      const blobOid = storeGitObject(repo, 'blob', content);
      const nextFiles = new Map(flat);
      nextFiles.set(path, { oid: blobOid, mode: '100644' });
      const { treeOid, newObjects } = rebuildTree(repo, nextFiles, baseTree);
      applyObjects(repo, newObjects);
      const parents = branchTip !== undefined ? [branchTip] : [];
      const { commitOid, objects: commitObjects } = commitOnBranch(repo, branch, treeOid, message, parents);
      applyObjects(repo, commitObjects);
      repo.refs.set(`refs/heads/${branch}`, commitOid);
      repo.updatedAt = TRIAL_NOW_ISO;
      sendJson(ctx, existing === undefined ? 201 : 200, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: content.length,
          type: 'file',
          encoding: 'base64',
          content: content.toString('base64'),
          url: `${baseUrlOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        },
        commit: { sha: commitOid, message, url: `${baseUrlOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${commitOid}` },
      });
      return true;
    }

    // DELETE
    if (existing === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing.oid) {
      sendError(ctx, 409, 'sha does not match');
      return true;
    }
    const nextFiles = new Map(flat);
    nextFiles.delete(path);
    const { treeOid, newObjects } = rebuildTree(repo, nextFiles, baseTree);
    applyObjects(repo, newObjects);
    const parents = branchTip !== undefined ? [branchTip] : [];
    const { commitOid, objects: commitObjects } = commitOnBranch(repo, branch, treeOid, message, parents);
    applyObjects(repo, commitObjects);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = TRIAL_NOW_ISO;
    sendJson(ctx, 200, {
      content: null,
      commit: { sha: commitOid, message, url: `${baseUrlOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${commitOid}` },
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

async function routeIssues(ctx: Ctx, method: string, repo: Repo, rest: string[]): Promise<boolean> {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const sort = ctx.url.searchParams.get('sort') ?? 'created';
      const direction = ctx.url.searchParams.get('direction') ?? 'desc';
      const labelFilter = ctx.url.searchParams.get('labels');
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (labelFilter !== null && labelFilter !== '') {
        const wanted = labelFilter.split(',').map((name) => name.trim());
        issues = issues.filter((issue) => wanted.every((name) => issue.labels.some((label) => label.name === name)));
      }
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      sendPage(ctx, issues.map((issue) => issueJson(baseUrlOf(ctx), repo, issue)));
      return true;
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(ctx.req);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = parsed.value;
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') {
        sendError(ctx, 422, 'Invalid title');
        return true;
      }
      const labels: Label[] = [];
      if (Array.isArray(body.labels)) {
        for (const name of body.labels) {
          if (typeof name !== 'string') continue;
          const label = repo.labels.find((candidate) => candidate.name === name);
          if (label === undefined) {
            sendError(ctx, 422, `Label '${name}' does not exist`);
            return true;
          }
          labels.push(label);
        }
      }
      const issue: Issue = {
        id: nextDbId(),
        number: repo.nextIssueNumber,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels,
        seq: nextSeq(),
        createdAt: TRIAL_NOW_ISO,
        updatedAt: TRIAL_NOW_ISO,
        comments: [],
      };
      repo.nextIssueNumber += 1;
      repo.issues.push(issue);
      sendJson(ctx, 201, issueJson(baseUrlOf(ctx), repo, issue));
      return true;
    }
    return false;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return false;
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (rest.length === 1) {
    if (method === 'GET') {
      if (issue === undefined) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      sendJson(ctx, 200, issueJson(baseUrlOf(ctx), repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      if (issue === undefined) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      const parsed = await readJsonBody(ctx.req);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = parsed.value;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      else if (body.state !== undefined) {
        sendError(ctx, 422, 'Invalid state');
        return true;
      }
      if (Array.isArray(body.labels)) {
        const labels: Label[] = [];
        for (const name of body.labels) {
          if (typeof name !== 'string') continue;
          const label = repo.labels.find((candidate) => candidate.name === name);
          if (label === undefined) {
            sendError(ctx, 422, `Label '${name}' does not exist`);
            return true;
          }
          labels.push(label);
        }
        issue.labels = labels;
      }
      issue.updatedAt = TRIAL_NOW_ISO;
      sendJson(ctx, 200, issueJson(baseUrlOf(ctx), repo, issue));
      return true;
    }
    return false;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') {
      sendPage(ctx, issue.comments.map((comment) => commentJson(baseUrlOf(ctx), repo, issue, comment)));
      return true;
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(ctx.req);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const bodyText = typeof parsed.value.body === 'string' ? parsed.value.body : '';
      if (bodyText === '') {
        sendError(ctx, 422, 'Invalid body');
        return true;
      }
      const comment = {
        id: nextDbId(),
        body: bodyText,
        seq: nextSeq(),
        createdAt: TRIAL_NOW_ISO,
        updatedAt: TRIAL_NOW_ISO,
      };
      issue.comments.push(comment);
      sendJson(ctx, 201, commentJson(baseUrlOf(ctx), repo, issue, comment));
      return true;
    }
    return false;
  }

  return false;
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function lineDiffCounts(base: Buffer, head: Buffer): { additions: number; deletions: number } {
  const baseLines = base.toString('utf8').split('\n');
  const headLines = head.toString('utf8').split('\n');
  const baseCounts = new Map<string, number>();
  for (const line of baseLines) baseCounts.set(line, (baseCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of headLines) {
    const remaining = baseCounts.get(line) ?? 0;
    if (remaining > 0) baseCounts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of baseCounts.values()) deletions += remaining;
  return { additions, deletions };
}

export function pullFiles(repo: Repo, pull: PullRequest): Array<Record<string, unknown>> {
  const base = mergeBase(pull.baseSha, pull.headSha, (oid) => repo.objects.get(oid));
  if (base === null) return [];
  const baseObj = repo.objects.get(base);
  const headObj = repo.objects.get(pull.headSha);
  if (baseObj === undefined || headObj === undefined || baseObj.type !== 'commit' || headObj.type !== 'commit') return [];
  const baseTree = flattenTree(parseCommit(baseObj.data).tree, (oid) => repo.objects.get(oid));
  const headTree = flattenTree(parseCommit(headObj.data).tree, (oid) => repo.objects.get(oid));
  const out: Array<Record<string, unknown>> = [];
  const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseTree.get(path);
    const h = headTree.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    let status: string;
    let additions = 0;
    let deletions = 0;
    if (b === undefined && h !== undefined) {
      status = 'added';
      const blob = repo.objects.get(h.oid);
      if (blob !== undefined) additions = blob.data.toString('utf8').split('\n').length;
    } else if (b !== undefined && h === undefined) {
      status = 'removed';
      const blob = repo.objects.get(b.oid);
      if (blob !== undefined) deletions = blob.data.toString('utf8').split('\n').length;
    } else {
      status = 'modified';
      const baseBlob = repo.objects.get(b!.oid);
      const headBlob = repo.objects.get(h!.oid);
      if (baseBlob !== undefined && headBlob !== undefined) {
        const counts = lineDiffCounts(baseBlob.data, headBlob.data);
        additions = counts.additions;
        deletions = counts.deletions;
      }
    }
    out.push({
      sha: h?.oid ?? b!.oid,
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    });
  }
  return out;
}

/** Merge a pull request (squash by default). Shared by REST and GraphQL.
 * "Ours" is the base branch's CURRENT tip, not the tip recorded when the
 * PR was opened: after another PR merges, a second PR that touched the
 * same files must conflict against the new tip, not the old one. */
export function doMergePullRequest(
  repo: Repo,
  pull: PullRequest,
  mergeMethod: string,
): { ok: true; sha: string } | { ok: false; status: number; message: string } {
  if (pull.merged) return { ok: false, status: 405, message: 'Pull request is already merged' };
  if (pull.state !== 'open') return { ok: false, status: 405, message: 'Pull request is closed' };
  if (mergeMethod !== 'squash' && mergeMethod !== 'merge') {
    return { ok: false, status: 422, message: 'Invalid merge method' };
  }
  const currentBaseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (currentBaseSha === undefined) return { ok: false, status: 405, message: 'Base branch does not exist' };
  const base = mergeBase(currentBaseSha, pull.headSha, (oid) => repo.objects.get(oid));
  if (base === null) return { ok: false, status: 405, message: 'No merge base' };
  const baseObj = repo.objects.get(base);
  const headObj = repo.objects.get(pull.headSha);
  const baseTipObj = repo.objects.get(currentBaseSha);
  if (baseObj === undefined || headObj === undefined || baseTipObj === undefined) {
    return { ok: false, status: 405, message: 'Merge conflict' };
  }
  const baseTree = flattenTree(parseCommit(baseObj.data).tree, (oid) => repo.objects.get(oid));
  const oursTree = flattenTree(parseCommit(baseTipObj.data).tree, (oid) => repo.objects.get(oid));
  const theirsTree = flattenTree(parseCommit(headObj.data).tree, (oid) => repo.objects.get(oid));
  const merged = threeWayMerge(baseTree, oursTree, theirsTree);
  if (merged === null) return { ok: false, status: 405, message: 'Merge conflict' };
  const baseRootTree = parseCommit(baseTipObj.data).tree;
  const { treeOid, newObjects } = rebuildTree(repo, merged, baseRootTree);
  applyObjects(repo, newObjects);
  const parents = mergeMethod === 'merge' ? [currentBaseSha, pull.headSha] : [currentBaseSha];
  const identity = forgeIdentity(TRIAL_NOW_SEC);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const commitData = buildCommit({ tree: treeOid, parents, author: identity, committer: identity, message });
  const commitOid = storeGitObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = TRIAL_NOW_ISO;
  pull.mergeCommitSha = commitOid;
  pull.updatedAt = TRIAL_NOW_ISO;
  repo.updatedAt = TRIAL_NOW_ISO;
  return { ok: true, sha: commitOid };
}

async function routePulls(ctx: Ctx, method: string, repo: Repo, rest: string[]): Promise<boolean> {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => a.number - b.number);
      sendPage(ctx, pulls.map((pull) => pullJson(baseUrlOf(ctx), repo, pull)));
      return true;
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(ctx.req);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = parsed.value;
      const title = typeof body.title === 'string' ? body.title : '';
      let head = typeof body.head === 'string' ? body.head : '';
      let base = typeof body.base === 'string' ? body.base : '';
      if (head.includes(':')) head = head.split(':').pop()!;
      if (base.includes(':')) base = base.split(':').pop()!;
      if (title === '' || head === '' || base === '') {
        sendError(ctx, 422, 'Invalid pull request');
        return true;
      }
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined) {
        sendError(ctx, 422, 'head branch does not exist');
        return true;
      }
      if (baseSha === undefined) {
        sendError(ctx, 422, 'base branch does not exist');
        return true;
      }
      const existing = repo.pulls.find(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (existing !== undefined) {
        sendError(ctx, 422, 'A pull request already exists for this branch');
        return true;
      }
      const pull: PullRequest = {
        id: nextDbId(),
        number: repo.nextPullNumber,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        seq: nextSeq(),
        createdAt: TRIAL_NOW_ISO,
        updatedAt: TRIAL_NOW_ISO,
      };
      repo.nextPullNumber += 1;
      repo.pulls.push(pull);
      sendJson(ctx, 201, pullJson(baseUrlOf(ctx), repo, pull));
      return true;
    }
    return false;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return false;
  const pull = repo.pulls.find((candidate) => candidate.number === number);

  if (rest.length === 1) {
    if (method === 'GET') {
      if (pull === undefined) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      sendJson(ctx, 200, pullJson(baseUrlOf(ctx), repo, pull));
      return true;
    }
    if (method === 'PATCH') {
      if (pull === undefined) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      const parsed = await readJsonBody(ctx.req);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      if (parsed.value.state === 'closed' && !pull.merged) pull.state = 'closed';
      else if (parsed.value.state === 'open' && !pull.merged) pull.state = 'open';
      pull.updatedAt = TRIAL_NOW_ISO;
      sendJson(ctx, 200, pullJson(baseUrlOf(ctx), repo, pull));
      return true;
    }
    return false;
  }

  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') return false;
    if (pull === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    sendJson(ctx, 200, pullFiles(repo, pull));
    return true;
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') return false;
    if (pull === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    const parsed = await readJsonBody(ctx.req);
    if (!parsed.ok) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return true;
    }
    const mergeMethod = typeof parsed.value.merge_method === 'string' ? parsed.value.merge_method : 'squash';
    const result = doMergePullRequest(repo, pull, mergeMethod);
    if (!result.ok) {
      sendError(ctx, result.status, result.message);
      return true;
    }
    sendJson(ctx, 200, { merged: true, sha: result.sha, message: 'Pull request successfully merged' });
    return true;
  }

  // Anything else under /api/v3 is a JSON 404 (with the request-id header,
  // which the protocol checks require on every reply).
  sendError(ctx, 404, 'Not Found');
  return true;
}

// Re-exported for the GraphQL and MCP modules (same store, same shapes).
export function repoView(repo: Repo): Record<string, unknown> {
  return repoJson('', repo);
}

export function issueView(issue: Issue, repo: Repo): Record<string, unknown> {
  return issueJson('', repo, issue);
}

export function pullView(pull: PullRequest, repo: Repo): Record<string, unknown> {
  return pullJson('', repo, pull);
}

export { computeMergeable };
export type { Ctx as RestCtx };
