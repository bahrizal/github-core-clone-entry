// Git primitives: object hashing, pkt-line framing, packfiles, object parsing
// and construction, reachability, tree manipulation and three-way merge.
// Everything here is stdlib only (node:crypto, node:zlib).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, ObjectType } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const PKT_LINE_MAX = 65520;

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export type GitPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush'; raw: Buffer }
  | { kind: 'delim'; raw: Buffer }
  | { kind: 'response-end'; raw: Buffer };

export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > PKT_LINE_MAX) throw new Error(`pkt-line of ${len} bytes exceeds ${PKT_LINE_MAX}`);
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function encodePktLines(lines: readonly (string | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(Buffer.from('0000', 'ascii'));
    else if (line === 'delim') parts.push(Buffer.from('0001', 'ascii'));
    else if (line === 'response-end') parts.push(Buffer.from('0002', 'ascii'));
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

export class PktLineDecoder {
  #buffer = Buffer.alloc(0);
  push(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
  }
  next(): GitPacket | null {
    if (this.#buffer.length < 4) return null;
    const len = parseInt(this.#buffer.subarray(0, 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(this.#buffer.subarray(0, 4).toString('ascii'))}`);
    if (len === 0) {
      const raw = this.#buffer.subarray(0, 4);
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'flush', raw };
    }
    if (len === 1) {
      const raw = this.#buffer.subarray(0, 4);
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'delim', raw };
    }
    if (len === 2) {
      const raw = this.#buffer.subarray(0, 4);
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'response-end', raw };
    }
    if (len < 4 || len > PKT_LINE_MAX) throw new Error(`pkt-line length ${len} out of range`);
    if (this.#buffer.length < len) return null;
    const raw = this.#buffer.subarray(0, len);
    const payload = this.#buffer.subarray(4, len);
    this.#buffer = this.#buffer.subarray(len);
    return { kind: 'data', payload, raw };
  }
  finish(): void {
    if (this.#buffer.length !== 0) throw new Error(`trailing ${this.#buffer.length} byte(s) after the last pkt-line`);
  }
}

/** Decode a whole buffer into packets (throws on malformed input). */
export function decodePktLines(buffer: Buffer): GitPacket[] {
  const decoder = new PktLineDecoder();
  decoder.push(buffer);
  const packets: GitPacket[] = [];
  for (;;) {
    const packet = decoder.next();
    if (packet === null) break;
    packets.push(packet);
  }
  decoder.finish();
  return packets;
}

// ---------------------------------------------------------------------------------------------
// packfiles (v2, plain objects; deltas resolved on read)
// ---------------------------------------------------------------------------------------------

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const size = object.data.length;
    const typeCode = TYPE_CODES[object.type];
    // varint header: first byte (type << 4) | (size & 0x0f), then 7-bit groups.
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = buffer[offset]! & 0x7f;
  let shift = 7;
  let pos = offset + 1;
  while ((buffer[pos - 1]! & 0x80) !== 0) {
    value |= (buffer[pos]! & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { value, next: pos };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readDeltaVarint();
  const targetSize = readDeltaVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const opcode = delta[pos]!;
    pos += 1;
    if ((opcode & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (opcode & 0x01) { offset = delta[pos]!; pos += 1; }
      if (opcode & 0x02) { offset |= delta[pos]! << 8; pos += 1; }
      if (opcode & 0x04) { offset |= delta[pos]! << 16; pos += 1; }
      if (opcode & 0x08) { offset |= delta[pos]! << 24; pos += 1; }
      if (opcode & 0x10) { size = delta[pos]!; pos += 1; }
      if (opcode & 0x20) { size |= delta[pos]! << 8; pos += 1; }
      if (opcode & 0x40) { size |= delta[pos]! << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (opcode !== 0) {
      out.push(delta.subarray(pos, pos + opcode));
      pos += opcode;
      produced += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, expected ${targetSize}`);
  }
  return result;
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  version: number;
  declaredCount: number;
}

export function readPack(pack: Buffer): ReadPackResult {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  const declaredCount = pack.readUInt32BE(8);
  const expectedTrailer = pack.subarray(pack.length - 20).toString('hex');
  const actualTrailer = sha1Hex(pack.subarray(0, pack.length - 20));
  if (expectedTrailer !== actualTrailer) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  // First pass: read raw entries.
  interface RawEntry { type: ObjectType | 'ofs-delta' | 'ref-delta'; data: Buffer; baseOffset?: number; baseOid?: string; offset: number; }
  const entries: RawEntry[] = [];
  for (let i = 0; i < declaredCount; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint.
      let value = pack[offset]! & 0x7f;
      let ofsByte = pack[offset]!;
      offset += 1;
      while ((ofsByte & 0x80) !== 0) {
        ofsByte = pack[offset]!;
        offset += 1;
        value = ((value + 1) << 7) | (ofsByte & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    // The zlib stream's length is unknown: inflateSync throws on a truncated
    // stream and ignores trailing bytes, so the smallest prefix that inflates
    // to exactly `size` bytes is the stream's end (binary search).
    let low = 1;
    let high = pack.length - 20 - offset;
    let consumed = -1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      try {
        const out = inflateSync(pack.subarray(offset, offset + mid));
        if (out.length === size) {
          consumed = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      } catch {
        low = mid + 1;
      }
    }
    if (consumed < 0) throw new Error('pack entry has no complete zlib stream');
    const data = inflateSync(pack.subarray(offset, offset + consumed));
    if (data.length !== size) throw new Error('pack entry inflated to the wrong size');
    offset += consumed;
    if (typeCode === 6) entries.push({ type: 'ofs-delta', data, baseOffset, offset: entryOffset });
    else if (typeCode === 7) entries.push({ type: 'ref-delta', data, baseOid, offset: entryOffset });
    else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      entries.push({ type, data, offset: entryOffset });
    }
  }
  // Resolve entries in order (deltas reference earlier entries or stored objects).
  const byOffset = new Map<number, GitObject>();
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      const object: GitObject = { type: entry.type, data: entry.data };
      byOffset.set(entry.offset, object);
      return object;
    }
    deltaCount += 1;
    let base: GitObject | undefined;
    if (entry.type === 'ofs-delta' && entry.baseOffset !== undefined) base = byOffset.get(entry.baseOffset);
    else if (entry.type === 'ref-delta' && entry.baseOid !== undefined) base = objects.get(entry.baseOid);
    if (base === undefined) throw new Error('delta base object not found');
    const data = applyDelta(base.data, entry.data);
    const object: GitObject = { type: base.type, data };
    byOffset.set(entry.offset, object);
    return object;
  };
  for (const entry of entries) {
    const object = resolve(entry);
    objects.set(hashObject(object.type, object.data), object);
  }
  return { objects, deltaCount, version, declaredCount };
}

// ---------------------------------------------------------------------------------------------
// object construction / parsing
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(pos, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(opts: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${opts.author}`);
  lines.push(`committer ${opts.committer}`);
  const message = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** The identity line for commits the forge itself authors. */
export function forgeIdentity(timestampSec: number): string {
  return `adaiversen <adaiversen@example.invalid> ${timestampSec} +0000`;
}

// ---------------------------------------------------------------------------------------------
// reachability and tree walking
// ---------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** All objects reachable from `roots` (commits, their trees/blobs, tag targets). */
export function collectReachable(roots: readonly string[], lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`missing object ${oid}`);
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
  return seen;
}

/** Commit oids reachable from `roots`, newest-first (DFS pre-order from the tips). */
export function reachableCommits(roots: readonly string[], lookup: ObjectLookup): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (oid: string): void => {
    if (oid === ZERO_OID || seen.has(oid)) return;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') return;
    seen.add(oid);
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) visit(parent);
  };
  for (const root of roots) visit(root);
  return order;
}

/** The merge-base of two commits: the first common ancestor in DFS order. */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const ancestorsA = new Set(reachableCommits([a], lookup));
  for (const commit of reachableCommits([b], lookup)) {
    if (ancestorsA.has(commit)) return commit;
  }
  return null;
}

/** A flat map of path -> { oid, mode } for a tree (recursive). */
export function flattenTree(rootOid: string, lookup: ObjectLookup): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (treeOid: string, prefix: string): void => {
    const object = lookup(treeOid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(rootOid, '');
  return out;
}

export interface TreeBuildResult {
  treeOid: string;
  newObjects: GitObject[];
}

/**
 * Build a new root tree from `files` (path -> blob oid + mode), reusing the
 * existing tree objects where subtrees are unchanged. Returns the new root
 * tree oid and every object that had to be created.
 */
export function buildTreeFromFiles(
  files: ReadonlyMap<string, { oid: string; mode: string }>,
  baseRootOid: string | null,
  lookup: ObjectLookup,
): TreeBuildResult {
  const newObjects: GitObject[] = [];
  const storeObject = (type: ObjectType, data: Buffer): string => {
    const oid = hashObject(type, data);
    const existing = lookup(oid);
    if (existing === undefined) {
      const object: GitObject = { type, data };
      newObjects.push(object);
    }
    return oid;
  };
  // Group files by their first path segment, recursively. `files` is the
  // COMPLETE desired state, so base entries not named by it are deletions
  // and must not be kept.
  const buildLevel = (prefix: string, baseTreeOid: string | null): string => {
    const baseEntries = new Map<string, TreeEntry>();
    if (baseTreeOid !== null) {
      const base = lookup(baseTreeOid);
      if (base !== undefined && base.type === 'tree') {
        for (const entry of parseTree(base.data)) baseEntries.set(entry.name, entry);
      }
    }
    const direct = new Map<string, { oid: string; mode: string }>();
    const dirNames = new Set<string>();
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) direct.set(rest, file);
      else dirNames.add(rest.slice(0, slash));
    }
    const entries: TreeEntry[] = [];
    for (const [name, file] of direct) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const dir of dirNames) {
      const baseSub = baseEntries.get(dir);
      const subOid = buildLevel(`${prefix}${dir}/`, baseSub !== undefined && baseSub.mode === '40000' ? baseSub.oid : null);
      entries.push({ mode: '40000', name: dir, oid: subOid });
    }
    const data = buildTree(entries);
    return storeObject('tree', data);
  };
  // The recursive builder above works on relative paths; adapt by passing the
  // full file map with a '' prefix.
  const rootOid = buildLevel('', baseRootOid);
  return { treeOid: rootOid, newObjects };
}

/**
 * Three-way merge of file maps (base, ours, theirs). Returns the merged map,
 * or null when the same path changed differently on both sides.
 */
export function threeWayMerge(
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  ours: ReadonlyMap<string, { oid: string; mode: string }>,
  theirs: ReadonlyMap<string, { oid: string; mode: string }>,
): Map<string, { oid: string; mode: string }> | null {
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x: { oid: string; mode: string } | undefined, y: { oid: string; mode: string } | undefined): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      return null; // both sides changed the path differently
    }
  }
  return merged;
}
