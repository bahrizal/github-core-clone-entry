// The forge's in-memory store: one process, one trial, no persistence.
//
// Identity: the suite's scenario is generated from a FIXED seed (kit
// program/env/src/wire.ts, SCENARIO_SEED 0x6a09e667f3bcc909n — "never change
// it"). The viewer is users[0] of generateUsers(scenarioRng('users'), 12),
// which this module re-derives with the same algorithm instead of trusting a
// hardcoded string. Verified locally: viewer = adaiversen (id 1000),
// teammate = quinnkeller, stranger = olgabauer.
//
// Time: the trial's only clock is MAKEFUN_TRIAL_NOW (the instance's opening
// time). Every timestamp the forge emits comes from it; ordering uses
// monotonic counters, never a wall clock and never Math.random().

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function generateUsers(): ScenarioUser[] {
  const rng = new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = generateUsers();
export const VIEWER: ScenarioUser = USERS[0]!;
export const TEAMMATE: ScenarioUser = USERS[1]!;
export const STRANGER: ScenarioUser = USERS[2]!;

/** The trial's now: MAKEFUN_TRIAL_NOW, or a fixed fallback for local runs. */
function trialNowMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = raw === '' ? NaN : Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  return Date.parse('2026-01-01T00:00:00Z');
}

export const TRIAL_NOW_MS = trialNowMs();
export const TRIAL_NOW_ISO = new Date(TRIAL_NOW_MS).toISOString();
export const TRIAL_NOW_SEC = Math.floor(TRIAL_NOW_MS / 1000);

/** One global monotonic sequence for creation order (never a clock). */
let seqCounter = 0;
export function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

/** One global monotonic id for every database object (repos, issues, ...). */
let idCounter = 0;
export function nextDbId(): number {
  idCounter += 1;
  return idCounter;
}

/** Opaque Relay global id: base64 of a typed key. Stable, never the plain number. */
export function globalId(kind: string, dbId: number): string {
  return Buffer.from(`${kind}:${dbId}`).toString('base64');
}

export function parseGlobalId(id: string): { kind: string; dbId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    const kind = text.slice(0, colon);
    const dbId = Number(text.slice(colon + 1));
    if (!Number.isInteger(dbId) || dbId <= 0) return null;
    return { kind, dbId };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------------------------

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
  seq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: PullRequest[];
  labels: Label[];
  nextIssueNumber: number;
  nextPullNumber: number;
}

export class Store {
  repos = new Map<string, Repo>(); // key: `${owner}/${name}` (lowercased owner/name)

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, opts: { private: boolean; description: string }): Repo {
    const repo: Repo = {
      id: nextDbId(),
      name,
      owner,
      private: opts.private,
      description: opts.description,
      defaultBranch: 'main',
      seq: nextSeq(),
      createdAt: TRIAL_NOW_ISO,
      updatedAt: TRIAL_NOW_ISO,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.toLowerCase() === owner.toLowerCase()) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  findByDbId(dbId: number): { kind: string; repo?: Repo; issue?: Issue; pull?: PullRequest; comment?: Comment } | null {
    for (const repo of this.repos.values()) {
      if (repo.id === dbId) return { kind: 'Repository', repo };
      for (const issue of repo.issues) {
        if (issue.id === dbId) return { kind: 'Issue', repo, issue };
        for (const comment of issue.comments) {
          if (comment.id === dbId) return { kind: 'IssueComment', repo, issue, comment };
        }
      }
      for (const pull of repo.pulls) {
        if (pull.id === dbId) return { kind: 'PullRequest', repo, pull };
      }
    }
    return null;
  }
}

export const store = new Store();
