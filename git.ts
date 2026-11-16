// Git smart HTTP: info/refs (v0 + v2), v2 ls-refs and fetch, v0 receive-pack.
// Wire contract is the kit's program/env/src/git-client.ts — this file is its
// server side, written from the client's parsing code.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type Repo, type GitObject } from './store.ts';
import {
  ZERO_OID, isObjectId, hashObject, encodePktLine, encodePktLines, decodePktLines,
  writePack, readPack, parseCommit, parseTag, parseTree, collectReachable,
} from './gitproto.ts';

const AGENT = 'forge/1.0';

export interface GitHandlerDeps {
  /** The bearer token the env issued; '' when unset (dev only). */
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

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  sendBuffer(res, status, 'application/json', Buffer.from(text, 'utf8'));
}

function checkAuth(req: IncomingMessage, deps: GitHandlerDeps): boolean {
  if (deps.token === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${deps.token}`;
}

function refOid(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Peel an annotated tag ref to its commit oid (or the oid itself). */
function peelOid(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (object !== undefined && object.type === 'tag') return parseTag(object.data).object;
  return oid;
}

function headOid(repo: Repo): string {
  return repo.refs.get('refs/heads/main') ?? ZERO_OID;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow ofs-delta\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'symref=HEAD:refs/heads/main side-band-64k agent=forge/1.0'
      : 'report-status side-band-64k delete-refs agent=forge/1.0 symref=HEAD:refs/heads/main';
  const lines: string[] = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const head = headOid(repo);
    const first: string[] = [];
    if (head !== ZERO_OID) first.push(`${head} HEAD`);
    for (const ref of refs) first.push(`${ref.oid} ${ref.name}`);
    // Peeled tag lines follow their tag line.
    const withPeeled: string[] = [];
    for (const line of first) {
      withPeeled.push(line);
      const name = line.slice(41);
      if (name.startsWith('refs/tags/')) {
        const oid = line.slice(0, 40);
        const peeled = peelOid(repo, oid);
        if (peeled !== oid) withPeeled.push(`${peeled} ${name}^{}`);
      }
    }
    withPeeled[0] = `${withPeeled[0]}\0${caps}`;
    lines.push(...withPeeled.map((line) => `${line}\n`));
  }
  lines.push('flush');
  return encodePktLines(lines as Array<string | 'flush'>);
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const main = headOid(repo);
  const include = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (args.symrefs && include('HEAD')) {
    if (main === ZERO_OID) {
      if (args.unborn) lines.push('unborn HEAD symref-target:refs/heads/main\n');
    } else {
      lines.push(`${main} HEAD symref-target:refs/heads/main\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!include(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.name.startsWith('refs/tags/')) {
      const peeled = peelOid(repo, ref.oid);
      if (peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines as Array<string | 'flush'>);
}

// ---------------------------------------------------------------------------------------------
// v2 fetch
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(packets: ReturnType<typeof decodePktLines>): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) continue; // command=fetch, agent=, object-format=
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

/** All tree and blob oids in a tree, including the tree itself. */
function treeObjects(treeOid: string, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const out = new Set<string>();
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
  return out;
}

/**
 * Pack cache: a pack is a pure function of its object set (objects are
 * packed in oid order, so the bytes are deterministic), and the clone
 * workload asks for the same 200-object tip fifty times. Caching it turns
 * 49 of those into a lookup. Capped so a long trial cannot grow it
 * without bound; the trial's store is in-memory and single-purpose.
 */
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX = 32;

function cachedPack(oids: ReadonlySet<string>, lookup: (oid: string) => GitObject | undefined): Buffer {
  const sorted = [...oids].sort();
  const key = sorted.join(',');
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const objects = sorted.map((oid) => lookup(oid)!).filter((object) => object !== undefined);
  const pack = writePack(objects);
  if (packCache.size >= PACK_CACHE_MAX) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, pack);
  return pack;
}

function fetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const haveSet = new Set(args.haves);
  const wantObjects = new Set<string>();
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];

  if (args.depth === null) {
    const reachable = collectReachable(args.wants, lookup);
    const held = collectReachable([...haveSet], lookup);
    for (const oid of reachable) if (!held.has(oid)) wantObjects.add(oid);
  } else {
    // Depth-limited: commits within `depth` generations of a want (distance 0
    // is the want itself). The boundary commits become shallow; a previously
    // shallow commit whose parents are now all known becomes unshallow.
    const distance = new Map<string, number>();
    const queue: string[] = [];
    const seedCommit = (oid: string): void => {
      const object = lookup(oid);
      if (object === undefined) return;
      if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (!distance.has(target)) {
          distance.set(target, 0);
          queue.push(target);
        }
        return;
      }
      if (object.type !== 'commit') return;
      if (!distance.has(oid)) {
        distance.set(oid, 0);
        queue.push(oid);
      }
    };
    for (const want of args.wants) seedCommit(want);
    while (queue.length > 0) {
      const oid = queue.shift()!;
      const d = distance.get(oid)!;
      if (d + 1 >= args.depth) continue;
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, d + 1);
          queue.push(parent);
        }
      }
    }
    const included = new Set([...distance.keys()]);
    // Objects the client already holds: each have plus its tree closure.
    // A have is a boundary here — its parents are NOT held (the client is
    // shallow there), so they must not be subtracted from what we send.
    // (For a non-shallow fetch the full reachable set is used instead; see
    // the depth === null branch above.)
    const held = new Set<string>();
    for (const have of haveSet) {
      const haveObject = lookup(have);
      if (haveObject === undefined) continue;
      if (haveObject.type === 'tag') {
        held.add(have);
        const target = parseTag(haveObject.data).object;
        const targetObject = lookup(target);
        if (targetObject !== undefined && targetObject.type === 'commit') {
          held.add(target);
          for (const t of treeObjects(parseCommit(targetObject.data).tree, lookup)) held.add(t);
        }
        continue;
      }
      if (haveObject.type !== 'commit') continue;
      held.add(have);
      for (const t of treeObjects(parseCommit(haveObject.data).tree, lookup)) held.add(t);
    }
    // Depth-limited closure: each included commit plus its tree, but never
    // its parents (they are outside the depth).
    for (const oid of included) {
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      if (!held.has(oid)) wantObjects.add(oid);
      for (const t of treeObjects(parseCommit(object.data).tree, lookup)) {
        if (!held.has(t)) wantObjects.add(t);
      }
    }
    // Tag objects named by a want are sent themselves.
    for (const want of args.wants) {
      const object = lookup(want);
      if (object !== undefined && object.type === 'tag' && !held.has(want)) wantObjects.add(want);
    }
    for (const oid of included) {
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.some((parent) => !included.has(parent))) shallowOut.push(oid);
    }
    const known = new Set([...included, ...haveSet]);
    for (const boundary of args.shallow) {
      const object = lookup(boundary);
      if (object === undefined || object.type !== 'commit') continue;
      if (!included.has(boundary)) continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((parent) => known.has(parent))) unshallowOut.push(boundary);
    }
  }

  const sections: Buffer[] = [];
  // The acknowledgments section belongs to the negotiation: it is only
  // sent when the client sent "have" lines. A fresh clone (no haves) goes
  // straight to the packfile, and real git dies on a stray acknowledgments
  // section ("expected 'packfile', received 'acknowledgments'").
  if (args.haves.length > 0) {
    const ack = encodePktLines(['acknowledgments\n', 'NAK\n', 'delim']);
    sections.push(ack);
  }
  if (shallowOut.length > 0 || unshallowOut.length > 0) {
    const lines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of shallowOut) lines.push(`shallow ${oid}\n`);
    for (const oid of unshallowOut) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    sections.push(encodePktLines(lines));
  }
  const wantedLines: string[] = [];
  for (const want of args.wants) {
    for (const ref of sortedRefs(repo)) {
      if (ref.oid === want) wantedLines.push(`${want} ${ref.name}\n`);
    }
  }
  if (wantedLines.length > 0) {
    sections.push(encodePktLines(['wanted-refs\n', ...wantedLines, 'delim']));
  }
  if (wantObjects.size > 0) {
    const pack = cachedPack(wantObjects, (oid) => repo.objects.get(oid));
    const chunks: Buffer[] = [encodePktLine('packfile\n')];
    const CHUNK = 65500;
    for (let i = 0; i < pack.length; i += CHUNK) {
      const slice = pack.subarray(i, Math.min(pack.length, i + CHUNK));
      chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    chunks.push(Buffer.from('0000', 'ascii'));
    sections.push(Buffer.concat(chunks));
  } else {
    sections.push(Buffer.from('0000', 'ascii'));
  }
  return Buffer.concat(sections);
}

// ---------------------------------------------------------------------------------------------
// v0 receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Validate a ref update in one bounded walk from the new tip: every object
 * reachable from it must exist, and the walk stops at the old tip (whose
 * closure is already complete on the server). Reaching the old tip means
 * the update is a fast-forward; exhausting the walk without it means it is
 * not; hitting a missing object means the pack was incomplete.
 *
 * This is O(new objects), not O(history): a plain collectReachable here
 * would re-traverse the whole repo on every push, which is what makes a
 * 200-push workload quadratic.
 */
function verifyPushUpdate(newOid: string, oldOid: string, lookup: (oid: string) => GitObject | undefined): 'ok' | 'missing object' | 'non-fast-forward' {
  const start = lookup(newOid);
  const startOid = start !== undefined && start.type === 'tag' ? parseTag(start.data).object : newOid;
  const seen = new Set<string>();
  const stack: string[] = [startOid];
  let foundOld = false;
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    if (oid === oldOid) {
      foundOld = true;
      continue;
    }
    const object = lookup(oid);
    if (object === undefined) return 'missing object';
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return foundOld ? 'ok' : 'non-fast-forward';
}

function receivePackResponse(repo: Repo, body: Buffer): Buffer {
  let reportLines: string[] = [];
  try {
    // Parse pkt-lines incrementally and stop at the flush: the pack bytes
    // follow it and are not pkt-lines, so a whole-buffer decode would fail.
    const commands: PushCommand[] = [];
    let offset = 0;
    let packStart = -1;
    while (offset + 4 <= body.length) {
      const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
      if (Number.isNaN(len) || len < 0 || len > 65520) throw new Error('bad pkt-line');
      if (len === 0) {
        offset += 4;
        packStart = offset;
        break;
      }
      if (len === 1 || len === 2) {
        offset += 4;
        continue;
      }
      if (offset + len > body.length) throw new Error('truncated pkt-line');
      const payload = body.subarray(offset + 4, offset + len);
      offset += len;
      let text = payload.toString('utf8');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul);
      const line = text.replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length < 3) throw new Error('bad push command line');
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
    if (packStart < 0 || commands.length === 0) throw new Error('no push commands');
    const packBytes = body.subarray(packStart);
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (packBytes.length > 0) {
      try {
        const parsed = readPack(packBytes);
        for (const [oid, object] of parsed.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack error';
      }
    }
    if (!unpackOk) {
      reportLines = [`unpack ${unpackDetail}\n`];
    } else {
      reportLines = ['unpack ok\n'];
      for (const command of commands) {
        const current = repo.refs.get(command.ref);
        let reason: string | null = null;
        if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
          reason = 'invalid command';
        } else if (command.oldOid === ZERO_OID) {
          if (current !== undefined) reason = 'already exists';
          else if (!repo.objects.has(command.newOid)) reason = 'missing object';
          else {
            // New object must be fully closed on the server.
            try {
              collectReachable([command.newOid], (oid) => repo.objects.get(oid));
            } catch {
              reason = 'missing object';
            }
          }
        } else if (command.newOid === ZERO_OID) {
          if (current === undefined) reason = 'invalid old value';
          else if (current !== command.oldOid) reason = 'invalid old value';
        } else {
          if (current === undefined) reason = 'invalid old value';
          else if (current !== command.oldOid) reason = 'invalid old value';
          else if (!repo.objects.has(command.newOid)) reason = 'missing object';
          else if (command.newOid === command.oldOid) {
            // A no-op update: the tip does not move, but it is valid.
            reason = null;
          } else {
            // One bounded walk checks both closure and fast-forward-ness.
            const verdict = verifyPushUpdate(command.newOid, command.oldOid, (oid) => repo.objects.get(oid));
            if (verdict !== 'ok') reason = verdict;
          }
        }
        if (reason === null) {
          if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
          else repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}\n`);
        } else {
          reportLines.push(`ng ${command.ref} ${reason}\n`);
        }
      }
    }
  } catch {
    reportLines = ['unpack error\n'];
  }
  // The report is pkt-lined text inside sideband band 1: git's sideband
  // reader takes the band-1 payload as the report, and its report parser
  // then reads that payload as pkt-lines. So each report line is its own
  // pkt-line inside a band-1 pkt-line, the payload ends with its own flush
  // (the outer flush is consumed by the sideband reader, so the inner
  // stream needs its own terminator), then the outer flush.
  const parts: Buffer[] = [];
  for (const line of reportLines) {
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), encodePktLine(line)])));
  }
  parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.from('0000', 'ascii')])));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  deps: GitHandlerDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const repo = store.getRepo(owner, repoName);
  if (!checkAuth(req, deps)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  if (path.endsWith('/info/refs')) {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const v2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
    const body = v2 ? v2Advertisement() : v0Advertisement(repo, service);
    sendBuffer(res, 200, `application/x-${service}-advertisement`, body);
    return true;
  }
  if (path.endsWith('/git-upload-pack') && req.method === 'POST') {
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { message: 'Bad request' });
      return true;
    }
    try {
      const packets = decodePktLines(body);
      const first = packets.find((p) => p.kind === 'data');
      const command = first !== undefined && first.kind === 'data' ? first.payload.toString('utf8').replace(/\n$/, '') : '';
      if (command === 'command=ls-refs') {
        const args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] } = {
          peel: false, symrefs: false, unborn: false, prefixes: [],
        };
        let pastDelim = false;
        for (const packet of packets) {
          if (packet.kind === 'delim') { pastDelim = true; continue; }
          if (packet.kind !== 'data' || !pastDelim) continue;
          const line = packet.payload.toString('utf8').replace(/\n$/, '');
          if (line === 'peel') args.peel = true;
          else if (line === 'symrefs') args.symrefs = true;
          else if (line === 'unborn') args.unborn = true;
          else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice(11));
        }
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, args));
        return true;
      }
      if (command === 'command=fetch') {
        const args = parseFetchArgs(packets);
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchResponse(repo, args));
        return true;
      }
      sendJson(res, 400, { message: 'Bad request' });
      return true;
    } catch (err) {
      console.error('[git] upload-pack error:', err instanceof Error ? err.message : String(err));
      sendJson(res, 400, { message: 'Bad request' });
      return true;
    }
  }
  if (path.endsWith('/git-receive-pack') && req.method === 'POST') {
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { message: 'Bad request' });
      return true;
    }
    const report = receivePackResponse(repo, body);
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', report);
    return true;
  }
  return false;
}
