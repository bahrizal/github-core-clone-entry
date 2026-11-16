// The forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP,
// all over the one in-memory store in store.ts.
//
// Routes:
//   GET  /healthz                    200 {"ok":true} (no auth; the env's boot check)
//   GET  /api/v3/                   API root (no auth)
//   /api/v3/*                       REST v3 (rest.ts)
//   POST /api/graphql               GraphQL v4 (graphql.ts)
//   POST /mcp                       Model Context Protocol (mcp.ts)
//   /:owner/:repo.git/info/refs     git advertisement
//   /:owner/:repo.git/git-upload-pack
//   /:owner/:repo.git/git-receive-pack
//   anything else                   404 {"message":"Not Found"}
//
// main.ts imports createApp() from here and nothing else. The token the
// suite presents is MAKEFUN_SHOP_TOKEN; an empty token means "accept all"
// (local smoke runs).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${requestCounter}`,
    ...headers,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const deps = { token };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    void (async () => {
      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // REST v3 (includes the API root, which is public).
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (await handleRest(req, res, deps)) return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (await handleGraphQL(req, res, deps)) return;
        }

        // Model Context Protocol.
        if (path === '/mcp') {
          if (await handleMcp(req, res, deps)) return;
        }

        // Git smart HTTP: /:owner/:repo.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
        if (gitMatch !== null) {
          const owner = gitMatch[1]!;
          const repoName = gitMatch[2]!;
          if (await handleGit(req, res, owner, repoName, deps)) return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler must never take the server down (the repo-survives-errors
        // check posts garbage at git-upload-pack on purpose).
        if (!res.headersSent) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 500, { message });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
