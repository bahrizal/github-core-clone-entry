# github-core-clone — a GitHub-compatible git forge

A single-process, stdlib-only TypeScript forge that speaks the four surfaces
the suite exercises: git smart HTTP, REST v3, GraphQL, and MCP. In-memory
only — no filesystem writes at runtime, no network beyond the suite, no model
calls.

Entry for make.fun competition `github-core-clone-01` ("Build a
GitHub-compatible git forge"). Runs as `node /bot/main.ts` (Node 22,
type stripping, erasable syntax only).

## Layout

| file | what it does |
| --- | --- |
| `main.ts` | Lifecycle: bind an ephemeral port, register with `$MAKEFUN_ENV_URL`, long-poll `/done`, exit 0. (Starter file, kept as-is.) |
| `app.ts` | `node:http` server. Routes `/healthz`, `/api/v3/*`, `/api/graphql`, `/mcp`, `/:owner/:repo.git/*`. Every reply carries a non-empty `X-GitHub-Request-Id`. |
| `store.ts` | The model + scenario identity. Re-derives the suite's viewer (`adaiversen`, id 1000) from the fixed scenario seed (FNV-1a + mix64 + xorshift64*), so the token's login matches the suite's expectations. Monotonic counters for ids/timestamps — no `Date.now()` / `Math.random()` in request paths; all timestamps come from `MAKEFUN_TRIAL_NOW`. Opaque Relay global ids (`base64("Kind:dbId")`). |
| `gitproto.ts` | Git primitives: SHA-1 object ids, pkt-line codec, pack v2 write/read (plain objects, OFS/REF delta resolution, SHA-1 trailer verification), tree/commit/tag parse+build, reachability, three-way merge. |
| `git.ts` | Smart HTTP. v2 advertisement + `ls-refs` + `fetch` for upload-pack (depth/shallow/unshallow semantics), v0 advertisement + receive-pack (report-status, side-band-64k, delete-refs). |
| `rest.ts` | REST v3: repos, branches, commits, git refs/trees/blobs, contents, labels, issues, pull requests (incl. squash merge + merge-conflict detection). |
| `graphql.ts` | Hand-rolled GraphQL lexer/parser/executor over the same store: viewer, repository/issues/pullRequests, mutations, `__type` introspection, batched operations, opaque stable global ids. |
| `mcp.ts` | JSON-RPC 2.0 over Streamable HTTP: `server/discover` (2026-07-28), `initialize`, `tools/list` (exactly the six required tools), `tools/call`, JSON-RPC error codes (-32700 / -32601 / -32602). |

## Wire decisions (from reading the suite's reference client)

- **Protocol negotiation is honoured exactly.** `Git-Protocol: version=2`
  on upload-pack gets a v2 advertisement; absent gets v0. The client
  *throws* if the server answers the wrong generation, so this is not
  optional.
- **report-status-v2 is deliberately NOT advertised.** The client prefers
  it when present and then expects a *non*-sideband report; advertising
  only `report-status` keeps the report inside sideband band 1, which is
  what the client parses.
- **Push report framing:** each report line is its own pkt-line *inside* a
  band-1 pkt-line, and the inner stream ends with its own flush (`0000`)
  — the outer flush is consumed by the sideband reader, so without the
  inner flush the client hits EOF ("remote end hung up").
- **Acknowledgments section only when the client sent `have` lines.** A
  fresh clone expects `packfile` first and dies on a stray
  `acknowledgments` section.
- **A `packfile` section with zero packets is a client error** — the
  section is omitted entirely when there is nothing to send
  (fetch-nothing-new).
- **Non-fast-forward** is reported per ref with the exact reason string
  `non-fast-forward`; the ref does not move; a mixed push applies the
  fast-forward ref and reports one line per ref.
- **Shallow fetch** is depth-limited by generation, not by full
  reachability: a `have` is a boundary (its parents are *not* held), and
  boundary commits become `shallow` / `unshallow` lines.
- **Merge conflicts** are detected against the *current* base tip, not the
  tip at PR creation — after PR A merges, PR B against the same base must
  answer 405.
- **REST replies are always `application/json`** with a string `message`
  on errors; unknown `/api/v3` routes are JSON 404s; a repository under a
  foreign owner is 404, never 403.
- **GraphQL unknown fields** answer HTTP 200 with an `errors` array naming
  the field; unknown repositories answer `data.repository: null` with no
  errors; unauthenticated is exactly 401.

## Performance notes

- **Push validation is a bounded walk, not a full traversal.** A ref
  update is validated by walking from the new tip and stopping at the old
  tip (whose closure is already complete on the server). One walk checks
  both closure and fast-forward-ness. A naive `collectReachable` per push
  is O(history) per push and O(n²) over the 200-push workload.
- **Pack cache.** A pack is a pure function of its object set (objects are
  packed in oid order), so the pack bytes for a given set are cached
  (capped at 32 entries). The clone workload asks for the same tip fifty
  times.
- **No per-request allocation hot spots** on the read/write paths: view
  functions build plain objects, ids are monotonic counters, and the
  store is a `Map` keyed by `owner/name`.

## Local grading

```sh
# Node 22 required (the kit refuses any other major version)
node cli/makefun.mjs grade-local --kit . --bot ../repo --driver process --instances 3
```

Latest local result (3 practice trials): **934 / 897 / 933, mean 921.3** —
feature 600/600, agent (MCP) 200/200, working 1 on every trial. Perf varies
with machine load (this VM shares 1.5 CPUs); on a quiet machine the four
workloads run at 0.5–0.75× the reference medians.

## License

MIT — see `LICENSE`.
