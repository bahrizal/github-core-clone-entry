// Handshake between the forge and the trial harness.
//
// The harness (the "env") owns port 8080 and runs the whole trial; this
// file only walks the entry through the wire protocol the kit spells out
// in RULES.txt. It serves no traffic itself and never touches the forge
// store — app.ts owns the score, this file only owns the lifecycle:
//
//   1. MAKEFUN_ENV_URL has to name the env origin. Without it there is
//      nobody to register with, so the process bows out with code 1.
//   2. The forge is built by createApp() and bound to port 0, letting
//      the kernel pick a free port. Port 8080 stays the env's.
//   3. The bound port is POSTed to <env>/register as {"port": N}.
//   4. <env>/done is polled until it answers {"done": true}.
//   5. The server is closed and the process leaves with code 0.
//
// The env answers both endpoints right away, so steps 3 and 4 are plain
// polls: a failed or slow attempt waits a little and tries again, the
// wait doubling each time up to a cap. The process never gives up and
// never exits early — only the env's "done" ends it.

import { createApp } from "./app.ts";

// The env origin, with any trailing slashes trimmed off.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");

// One call to the env may hang while it is still starting, so each call
// gets this long before it is abandoned and the attempt retried.
const CALL_BUDGET_MS = 20_000;
// The pause after a failed attempt starts here and doubles, up to...
const FIRST_PAUSE_MS = 200;
const LONGEST_PAUSE_MS = 3_000;

// A sleeper whose delay doubles after every use, capped at LONGEST_PAUSE_MS.
function makeSleeper(): () => Promise<void> {
  let pause = FIRST_PAUSE_MS;
  return async () => {
    await new Promise<void>((wake) => setTimeout(wake, pause));
    pause = Math.min(LONGEST_PAUSE_MS, pause * 2);
  };
}

// fetch() with a hard time limit: the env is local, so a call that runs
// long is a call that will never answer.
async function callEnv(url: string, init?: RequestInit): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CALL_BUDGET_MS);
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Statuses that mean "registered": 200 is the normal accept, and 409
// means another entry registered first — waiting is still the right move.
const REGISTERED = new Set([200, 409]);
// Statuses that mean the register itself is wrong: retrying cannot help.
const REJECTED = new Set([400, 405]);

// POST the bound port until the env takes it. Anything else — a network
// error, a timeout, an unexpected status — is treated as "the env is not
// ready yet" and retried after a growing pause.
async function announce(port: number): Promise<void> {
  const sleep = makeSleeper();
  for (;;) {
    const reply = await callEnv(`${envOrigin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: port }),
    }).catch(() => null);
    if (reply === null) {
      await sleep();
      continue;
    }
    if (REGISTERED.has(reply.status)) return;
    if (REJECTED.has(reply.status)) {
      throw new Error(`register turned down with HTTP ${reply.status}: ${await reply.text()}`);
    }
    await sleep();
  }
}

// GET /done until it answers {"done": true}. A failed poll, a slow poll
// or a "false" body all mean the same thing — not finished yet.
async function awaitFinish(): Promise<void> {
  const sleep = makeSleeper();
  for (;;) {
    const finished = await callEnv(`${envOrigin}/done`)
      .then(async (reply) => {
        if (!reply.ok) return false;
        const payload = (await reply.json()) as { done?: unknown };
        return payload.done === true;
      })
      .catch(() => false);
    if (finished) return;
    await sleep();
  }
}

// Build the forge and bind it to a kernel-chosen port.
async function standUp(): Promise<{ server: ReturnType<typeof createApp>; port: number }> {
  const server = createApp();
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, () => {
      ok();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("forge failed to bind a TCP port");
  }
  return { server, port: bound.port };
}

// The whole life of the process: stand up, announce, wait, shut down.
// Returns the exit code: 1 when there is no env to talk to, else 0.
async function run(): Promise<number> {
  if (envOrigin === "") {
    process.stderr.write("[forge] MAKEFUN_ENV_URL is unset — no env to register with\n");
    return 1;
  }
  const { server, port } = await standUp();
  process.stdout.write(`[forge] listening on ${port}\n`);
  await announce(port);
  process.stdout.write("[forge] registered — waiting for the env to finish\n");
  await awaitFinish();
  server.close(); // the suite is done; no more traffic is coming.
  process.stdout.write("[forge] env done — exiting\n");
  return 0;
}

run().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
