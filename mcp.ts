// Model Context Protocol over Streamable HTTP, for github-mcp-server's tool
// calls (kit program/env/src/checks-mcp.ts). Two eras are supported:
//
//  - Modern 2026-07-28: server/discover first; every request declares the
//    revision in _meta['io.modelcontextprotocol/protocolVersion'] and in the
//    MCP-Protocol-Version header. No handshake, no session.
//  - Legacy 2025-11-25 and earlier: initialize + notifications/initialized
//    (optional Mcp-Session-Id; we issue none).
//
// tools/list offers exactly the six tools the suite looks for, with the
// canonical argument names (create_repo {name}, get_repo {owner, repo},
// create_issue {owner, repo, title, body?}, list_issues {owner, repo, state?},
// create_pull_request {owner, repo, title, head, base}, merge_pull_request
// {owner, repo, pull_number}). The suite maps documented names onto the
// schema's nearest property by synonym, so canonical names are what it
// needs. Two tools/list calls answer byte-for-byte identical lists.
//
// All tools act on the same store as REST: a repo or issue created over MCP
// reads back over /api/v3 as the same object, ids unchanged.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, VIEWER, nextDbId, nextSeq, TRIAL_NOW_ISO } from './store.ts';
import { repoView, issueView, doMergePullRequest } from './rest.ts';

const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-core-clone-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  run: (args: Record<string, unknown>) => Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (args) => {
      const name = String(args.name ?? '');
      if (name === '') throw new McpToolError('name is required');
      const repo = store.createRepo(VIEWER.login, name, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return repoView(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
    run: (args) => {
      const owner = String(args.owner ?? '');
      const repoName = String(args.repo ?? '');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) throw new McpToolError(`Repository ${owner}/${repoName} not found`, 404);
      return repoView(repo);
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (args) => {
      const owner = String(args.owner ?? '');
      const repoName = String(args.repo ?? '');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) throw new McpToolError(`Repository ${owner}/${repoName} not found`, 404);
      const issue = {
        id: nextDbId(),
        number: repo.nextIssueNumber,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as never[],
        seq: nextSeq(),
        createdAt: TRIAL_NOW_ISO,
        updatedAt: TRIAL_NOW_ISO,
        comments: [] as never[],
      };
      repo.nextIssueNumber += 1;
      repo.issues.push(issue);
      return issueView(issue, repo);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
    run: (args) => {
      const owner = String(args.owner ?? '');
      const repoName = String(args.repo ?? '');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) throw new McpToolError(`Repository ${owner}/${repoName} not found`, 404);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return { issues: issues.map((issue) => issueView(issue, repo)) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The name of the branch containing the changes.' },
        base: { type: 'string', description: 'The name of the branch to merge into.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (args) => {
      const owner = String(args.owner ?? '');
      const repoName = String(args.repo ?? '');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) throw new McpToolError(`Repository ${owner}/${repoName} not found`, 404);
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        throw new McpToolError(`Head or base branch does not exist (${head} -> ${base})`, 422);
      }
      const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (existing !== undefined) throw new McpToolError('A pull request already exists for this branch.', 422);
      const pull = {
        id: nextDbId(),
        number: repo.nextPullNumber,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        merged: false,
        mergedAt: null as string | null,
        mergeCommitSha: null as string | null,
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
      return {
        number: pull.number,
        pull_number: pull.number,
        title: pull.title,
        state: pull.state,
        head: { ref: head, sha: headSha },
        base: { ref: base, sha: baseSha },
      };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (args) => {
      const owner = String(args.owner ?? '');
      const repoName = String(args.repo ?? '');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) throw new McpToolError(`Repository ${owner}/${repoName} not found`, 404);
      const pullNumber = Number(args.pull_number);
      const pull = repo.pulls.find((candidate) => candidate.number === pullNumber);
      if (pull === undefined) throw new McpToolError(`Pull request #${pullNumber} not found`, 404);
      const result = doMergePullRequest(repo, pull, 'squash');
      if (!result.ok) throw new McpToolError(result.message, result.status);
      return {
        number: pull.number,
        pull_number: pull.number,
        merged: true,
        sha: result.sha,
        state: pull.state,
      };
    },
  },
];

class McpToolError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

function toolsListPayload(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

function jsonRpcResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function sendJsonRpc(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export interface McpDeps {
  token: string;
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, deps: McpDeps): Promise<boolean> {
  if (req.method === 'GET' || req.method === 'DELETE') {
    // No sessions are issued, so there is nothing to close.
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' } }));
    return true;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' } }));
    return true;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return true;
  }
  const text = raw.toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // A body that is not JSON: HTTP 400 with a -32700 (the modern era's
    // rule; the suite accepts 200 with -32700 only from pre-2026-07-28
    // servers, and we are a modern one).
    sendJsonRpc(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJsonRpc(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const request = body as Record<string, unknown>;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
    ? request.params
    : {}) as Record<string, unknown>;

  // A notification (no id) answers with an empty 202.
  if (id === null && request.id === undefined) {
    res.writeHead(202, { 'content-type': 'application/json', 'content-length': '0' });
    res.end();
    return true;
  }

  // Authentication: a tools/call without a Bearer token is a 401.
  if (deps.token !== '') {
    const header = req.headers.authorization ?? '';
    if (header !== `Bearer ${deps.token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Requires authentication' }));
      return true;
    }
  }

  if (method === 'server/discover') {
    sendJsonRpc(res, 200, jsonRpcResult(id, {
      supportedVersions: REVISIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    }));
    return true;
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' && params.protocolVersion !== '' ? params.protocolVersion : '2025-11-25';
    sendJsonRpc(res, 200, jsonRpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    }));
    return true;
  }

  if (method === 'tools/list') {
    sendJsonRpc(res, 200, jsonRpcResult(id, toolsListPayload()));
    return true;
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((candidate) => candidate.name === toolName);
    if (tool === undefined) {
      sendJsonRpc(res, 200, jsonRpcError(id, -32602, `Unknown tool: ${toolName}`));
      return true;
    }
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments
      : {}) as Record<string, unknown>;
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      sendJsonRpc(res, 200, jsonRpcResult(id, {
        content: [{ type: 'text', text: `Missing required argument: ${missing.join(', ')}` }],
        isError: true,
      }));
      return true;
    }
    try {
      const result = tool.run(args);
      sendJsonRpc(res, 200, jsonRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      }));
    } catch (err) {
      if (err instanceof McpToolError) {
        sendJsonRpc(res, 200, jsonRpcResult(id, {
          content: [{ type: 'text', text: err.message }],
          isError: true,
        }));
        return true;
      }
      throw err;
    }
    return true;
  }

  sendJsonRpc(res, 200, jsonRpcError(id, -32601, `Method not found: ${method}`));
  return true;
}
