/** Minimal POSIX ustar/PAX tar + Node 24 built-in zstd container for cold archives. */
import * as fs from 'node:fs';
import { Writable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';

const BLOCK = 512;
const MAX_USTAR_NAME = 100;
const MAX_USTAR_SIZE = 0o77777777777; // 8 GiB - 1
export const DEFAULT_ZSTD_FRAME_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_SYNC_FRAME_BYTES = 64 * 1024 * 1024;
const ZSTD_STREAM_CHUNK_BYTES = 256 * 1024;
const MAX_PAX_META_BYTES = 1024 * 1024;
const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MASK = 0xfffffff0;
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;

type ZstdLib = typeof zlib & {
  zstdCompressSync: (buf: zlib.InputType, options?: { params?: Record<number, number> }) => Buffer;
  zstdDecompressSync: (buf: zlib.InputType, options?: { maxOutputLength?: number }) => Buffer;
  createZstdDecompress: (options?: { chunkSize?: number; maxOutputLength?: number }) => Transform;
};
const zstd = zlib as ZstdLib;

export interface TarEntry {
  name: string;
  data: Buffer;
  mode?: number;
  mtime?: number;
}

export interface TarFileEntry {
  name: string;
  filePath: string;
  size: number;
  mode?: number;
  mtime?: number;
  dev?: number;
  ino?: number;
}

export type TarInput = TarEntry | TarFileEntry;

export interface TarEntryMeta {
  name: string;
  size: number;
  mode: number;
  mtime: number;
}

export interface TarStreamHandler {
  onEntryStart: (meta: TarEntryMeta) => void;
  onEntryData: (chunk: Buffer) => void;
  onEntryEnd: () => void;
}

export interface ZstdFrameReadOptions {
  maxFrameDecompressedBytes?: number;
  maxFrameCompressedBytes?: number;
}

export function isTarFileEntry(entry: TarInput): entry is TarFileEntry {
  return 'filePath' in entry;
}

export function isSafeTarPath(name: string): boolean {
  if (!name || name.startsWith('/') || name.includes('\0') || name.includes('\\')) return false;
  const parts = name.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

export function writeAllSync(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    const written = fs.writeSync(fd, buf, offset, buf.length - offset);
    if (written <= 0) throw new Error('short_write');
    offset += written;
  }
}

function readExactSync(fd: number, buf: Buffer, length: number, position: number): void {
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, buf, offset, length - offset, position + offset);
    if (count <= 0) throw new Error('truncated_zstd_stream');
    offset += count;
  }
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const clamped = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const octal = clamped.toString(8).padStart(length - 1, '0');
  if (octal.length > length - 1) throw new Error(`tar_octal_overflow:${value}`);
  buf.write(octal, offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function buildHeader(name: string, size: number, mode: number, mtime: number, typeflag: string): Buffer {
  const header = Buffer.alloc(BLOCK);
  const nameBytes = Buffer.from(name, 'utf8');
  if (nameBytes.length > MAX_USTAR_NAME) {
    nameBytes.subarray(0, MAX_USTAR_NAME).copy(header, 0);
  } else {
    nameBytes.copy(header, 0);
  }
  writeOctal(header, 100, 8, mode & 0o7777);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size <= MAX_USTAR_SIZE ? size : 0);
  writeOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156);
  header[156] = typeflag.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i]!;
  const chk = sum.toString(8).padStart(6, '0');
  header.write(chk, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function paxRecord(key: string, value: string): Buffer {
  const rest = ` ${key}=${value}\n`;
  const restBytes = Buffer.byteLength(rest, 'utf8');
  let len = restBytes + 1;
  while (Buffer.byteLength(String(len), 'ascii') + restBytes !== len) {
    len = Buffer.byteLength(String(len), 'ascii') + restBytes;
  }
  return Buffer.from(`${len}${rest}`, 'utf8');
}

function padBlock(size: number): Buffer {
  const rem = size % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem);
}

function needsPax(name: string, size: number): boolean {
  if (size > MAX_USTAR_SIZE) return true;
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length > MAX_USTAR_NAME) return true;
  for (let i = 0; i < bytes.length; i++) if (bytes[i]! >= 0x80) return true;
  return false;
}

function buildEntryHeaders(name: string, size: number, mode: number, mtime: number, paxIndex: number): Buffer[] {
  const out: Buffer[] = [];
  if (needsPax(name, size)) {
    const records: Buffer[] = [paxRecord('path', name)];
    if (size > MAX_USTAR_SIZE) records.push(paxRecord('size', String(size)));
    const paxData = Buffer.concat(records);
    const paxName = `PaxHeader/${paxIndex}`;
    out.push(buildHeader(paxName, paxData.length, 0o600, mtime, 'x'), paxData, padBlock(paxData.length));
  }
  const shortName = Buffer.from(name, 'utf8').length <= MAX_USTAR_NAME
    ? name
    : name.replace(/[^\x20-\x7e]/g, '_').slice(0, MAX_USTAR_NAME);
  out.push(buildHeader(shortName, size, mode, mtime, '0'));
  return out;
}

/** Synchronous streaming tar + multi-frame zstd writer with bounded memory. */
export class TarZstFrameWriter {
  private readonly fd: number;
  private readonly buf: Buffer;
  private used = 0;
  private readonly seen = new Set<string>();
  private inEntry = false;
  private expectedBytes = 0;
  private writtenBytes = 0;
  private finished = false;

  constructor(fd: number, frameBytes = DEFAULT_ZSTD_FRAME_BYTES) {
    if (!Number.isSafeInteger(frameBytes) || frameBytes < BLOCK) {
      throw new Error(`invalid_zstd_frame_bytes:${frameBytes}`);
    }
    this.fd = fd;
    this.buf = Buffer.allocUnsafe(frameBytes);
  }

  private flushFrame(): void {
    if (this.used === 0) return;
    const compressed = zstd.zstdCompressSync(this.buf.subarray(0, this.used));
    writeAllSync(this.fd, compressed);
    this.used = 0;
  }

  private writeRaw(data: Buffer): void {
    let offset = 0;
    while (offset < data.length) {
      const space = this.buf.length - this.used;
      const take = Math.min(space, data.length - offset);
      data.copy(this.buf, this.used, offset, offset + take);
      this.used += take;
      offset += take;
      if (this.used === this.buf.length) this.flushFrame();
    }
  }

  beginEntry(meta: { name: string; size: number; mode?: number; mtime?: number }): void {
    if (this.finished) throw new Error('tar_writer_finished');
    if (this.inEntry) throw new Error('tar_entry_unclosed');
    if (!isSafeTarPath(meta.name)) throw new Error(`invalid_tar_path:${meta.name}`);
    if (this.seen.has(meta.name)) throw new Error(`duplicate_tar_path:${meta.name}`);
    if (!Number.isSafeInteger(meta.size) || meta.size < 0) throw new Error(`invalid_tar_size:${meta.size}`);
    this.seen.add(meta.name);
    const mode = meta.mode ?? 0o600;
    const mtime = meta.mtime !== undefined && Number.isFinite(meta.mtime) ? Math.max(0, Math.floor(meta.mtime)) : 0;
    for (const part of buildEntryHeaders(meta.name, meta.size, mode, mtime, this.seen.size)) {
      this.writeRaw(part);
    }
    this.inEntry = true;
    this.expectedBytes = meta.size;
    this.writtenBytes = 0;
  }

  writeEntryData(chunk: Buffer): void {
    if (!this.inEntry) throw new Error('tar_entry_not_open');
    if (chunk.length === 0) return;
    if (this.writtenBytes + chunk.length > this.expectedBytes) throw new Error('tar_entry_size_overflow');
    this.writeRaw(chunk);
    this.writtenBytes += chunk.length;
  }

  endEntry(): void {
    if (!this.inEntry) throw new Error('tar_entry_not_open');
    if (this.writtenBytes !== this.expectedBytes) throw new Error('tar_entry_size_mismatch');
    this.writeRaw(padBlock(this.expectedBytes));
    this.inEntry = false;
    this.expectedBytes = 0;
    this.writtenBytes = 0;
  }

  finish(): void {
    if (this.finished) return;
    if (this.inEntry) throw new Error('tar_entry_unclosed');
    this.writeRaw(Buffer.alloc(BLOCK * 2));
    this.flushFrame();
    this.finished = true;
  }
}

function readString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8');
}

function readOctal(buf: Buffer, start: number, length: number): number {
  const raw = readString(buf, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error(`invalid_tar_octal:${raw}`);
  return Number.parseInt(raw, 8);
}

function verifyChecksum(header: Buffer): void {
  const stored = readOctal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  if (sum !== stored) throw new Error('invalid_tar_checksum');
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp === -1) throw new Error('invalid_pax_record');
    const len = Number.parseInt(data.subarray(pos, sp).toString('ascii'), 10);
    if (!Number.isSafeInteger(len) || len <= sp - pos + 1 || pos + len > data.length) throw new Error('invalid_pax_length');
    const record = data.subarray(sp + 1, pos + len);
    if (record[record.length - 1] !== 0x0a) throw new Error('invalid_pax_newline');
    const eq = record.indexOf(0x3d);
    if (eq > 0) out[record.subarray(0, eq).toString('utf8')] = record.subarray(eq + 1, record.length - 1).toString('utf8');
    pos += len;
  }
  return out;
}

function isZeroBlock(buf: Buffer, offset: number): boolean {
  for (let i = 0; i < BLOCK; i++) if (buf[offset + i] !== 0) return false;
  return true;
}

/** Incremental POSIX ustar/PAX tar parser with O(1) memory per chunk. */
export class TarStreamParser {
  private readonly handler: TarStreamHandler;
  private state: 'header' | 'data' | 'meta' | 'skip' | 'pad' | 'eof' = 'header';
  private readonly headerBuf = Buffer.allocUnsafe(BLOCK);
  private headerUsed = 0;
  private remaining = 0;
  private padRemaining = 0;
  private metaType: 'x' | 'L' = 'x';
  private metaBuf = Buffer.alloc(0);
  private metaUsed = 0;
  private pax: Record<string, string> | null = null;
  private gnuLongName: string | null = null;
  private totalBytes = 0;

  constructor(handler: TarStreamHandler) {
    this.handler = handler;
  }

  push(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    let offset = 0;
    while (offset < chunk.length) {
      if (this.state === 'eof') {
        offset = chunk.length;
        break;
      }
      if (this.state === 'header') {
        const take = Math.min(BLOCK - this.headerUsed, chunk.length - offset);
        chunk.copy(this.headerBuf, this.headerUsed, offset, offset + take);
        this.headerUsed += take;
        offset += take;
        if (this.headerUsed === BLOCK) {
          this.headerUsed = 0;
          this.processHeader(this.headerBuf);
        }
        continue;
      }
      if (this.state === 'data') {
        const take = Math.min(this.remaining, chunk.length - offset);
        this.handler.onEntryData(chunk.subarray(offset, offset + take));
        offset += take;
        this.remaining -= take;
        if (this.remaining === 0) {
          this.handler.onEntryEnd();
          this.state = this.padRemaining > 0 ? 'pad' : 'header';
        }
        continue;
      }
      if (this.state === 'meta') {
        const take = Math.min(this.remaining, chunk.length - offset);
        chunk.copy(this.metaBuf, this.metaUsed, offset, offset + take);
        this.metaUsed += take;
        offset += take;
        this.remaining -= take;
        if (this.remaining === 0) {
          this.finishMeta();
          this.state = this.padRemaining > 0 ? 'pad' : 'header';
        }
        continue;
      }
      if (this.state === 'skip') {
        const take = Math.min(this.remaining, chunk.length - offset);
        offset += take;
        this.remaining -= take;
        if (this.remaining === 0) {
          this.state = this.padRemaining > 0 ? 'pad' : 'header';
        }
        continue;
      }
      if (this.state === 'pad') {
        const take = Math.min(this.padRemaining, chunk.length - offset);
        offset += take;
        this.padRemaining -= take;
        if (this.padRemaining === 0) this.state = 'header';
      }
    }
  }

  finish(): void {
    if (this.totalBytes % BLOCK !== 0) throw new Error('invalid_tar_alignment');
    if (this.state !== 'header' && this.state !== 'eof') throw new Error('truncated_tar_entry');
    if (this.headerUsed !== 0) throw new Error('truncated_tar_entry');
  }

  private finishMeta(): void {
    const data = this.metaBuf;
    this.metaBuf = Buffer.alloc(0);
    this.metaUsed = 0;
    if (this.metaType === 'x') {
      this.pax = parsePax(data);
    } else {
      const nul = data.indexOf(0);
      this.gnuLongName = (nul === -1 ? data : data.subarray(0, nul)).toString('utf8');
    }
  }

  private processHeader(header: Buffer): void {
    if (isZeroBlock(header, 0)) {
      this.state = 'eof';
      return;
    }
    verifyChecksum(header);
    const type = String.fromCharCode(header[156]!);
    const mode = readOctal(header, 100, 8);
    const mtime = readOctal(header, 136, 12);
    const headerSize = readOctal(header, 124, 12);
    const size = this.pax?.size !== undefined ? Number(this.pax.size) : headerSize;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid_tar_size');
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;

    if (type === 'x' || type === 'L') {
      if (size > MAX_PAX_META_BYTES) throw new Error('tar_metadata_too_large');
      this.metaType = type;
      this.metaBuf = Buffer.allocUnsafe(size);
      this.metaUsed = 0;
      this.remaining = size;
      this.padRemaining = pad;
      if (size === 0) {
        this.finishMeta();
        this.state = pad > 0 ? 'pad' : 'header';
      } else {
        this.state = 'meta';
      }
      return;
    }

    const rawName = readString(header, 0, MAX_USTAR_NAME);
    const prefix = readString(header, 345, 155);
    const name = this.pax?.path ?? this.gnuLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    this.pax = null;
    this.gnuLongName = null;

    if (type === '5') {
      this.remaining = size;
      this.padRemaining = pad;
      this.state = size > 0 ? 'skip' : pad > 0 ? 'pad' : 'header';
      return;
    }
    if (type !== '0' && type !== '\0') throw new Error(`unsupported_tar_type:${type}`);
    if (!isSafeTarPath(name)) throw new Error(`unsafe_tar_path:${name}`);

    this.handler.onEntryStart({ name, size, mode, mtime });
    if (size === 0) {
      this.handler.onEntryEnd();
      this.state = 'header';
      return;
    }
    this.remaining = size;
    this.padRemaining = pad;
    this.state = 'data';
  }
}

/** Stream a concatenated-frame zstd file synchronously, one RFC 8878 frame at a time. */
export function forEachZstdFrameSync(
  fd: number,
  fileSize: number,
  onChunk: (decompressed: Buffer) => void,
  options: ZstdFrameReadOptions = {},
): void {
  const maxDecompressed = options.maxFrameDecompressedBytes ?? DEFAULT_MAX_SYNC_FRAME_BYTES;
  const maxCompressed = options.maxFrameCompressedBytes ?? (maxDecompressed + 1024 * 1024);
  const small = Buffer.allocUnsafe(8);
  let pos = 0;
  while (pos < fileSize) {
    if (pos + 4 > fileSize) throw new Error('truncated_zstd_magic');
    readExactSync(fd, small, 4, pos);
    const magic = small.readUInt32LE(0);
    if ((magic & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE_MAGIC) {
      if (pos + 8 > fileSize) throw new Error('truncated_zstd_skippable');
      readExactSync(fd, small, 4, pos + 4);
      const skipSize = small.readUInt32LE(0);
      const next = pos + 8 + skipSize;
      if (next > fileSize) throw new Error('truncated_zstd_skippable_payload');
      pos = next;
      continue;
    }
    if (magic !== ZSTD_MAGIC) throw new Error(`invalid_zstd_magic:${magic.toString(16)}`);
    const frameStart = pos;
    pos += 4;
    if (pos >= fileSize) throw new Error('truncated_zstd_fhd');
    readExactSync(fd, small, 1, pos);
    const fhd = small[0]!;
    pos += 1;
    const fcsFlag = (fhd >>> 6) & 3;
    const singleSeg = (fhd >>> 5) & 1;
    const unused = (fhd >>> 4) & 1;
    const reserved = (fhd >>> 3) & 1;
    const checksum = (fhd >>> 2) & 1;
    const didFlag = fhd & 3;
    if (unused !== 0 || reserved !== 0) throw new Error('invalid_zstd_fhd');
    if (!singleSeg) pos += 1;
    pos += [0, 1, 2, 4][didFlag]!;
    pos += fcsFlag === 0 ? (singleSeg ? 1 : 0) : [0, 2, 4, 8][fcsFlag]!;
    if (pos > fileSize) throw new Error('truncated_zstd_header');
    while (true) {
      if (pos + 3 > fileSize) throw new Error('truncated_zstd_block_header');
      readExactSync(fd, small, 3, pos);
      const bh = small[0]! | (small[1]! << 8) | (small[2]! << 16);
      pos += 3;
      const lastBlock = bh & 1;
      const blockType = (bh >>> 1) & 3;
      const blockSize = bh >>> 3;
      if (blockType === 3) throw new Error('reserved_zstd_block');
      pos += blockType === 1 ? 1 : blockSize;
      if (pos > fileSize) throw new Error('truncated_zstd_block');
      if (lastBlock) break;
    }
    if (checksum) {
      pos += 4;
      if (pos > fileSize) throw new Error('truncated_zstd_checksum');
    }
    const frameLen = pos - frameStart;
    if (frameLen > maxCompressed) throw new Error(`zstd_frame_too_large:${frameLen}`);
    const frameBuf = Buffer.allocUnsafe(frameLen);
    readExactSync(fd, frameBuf, frameLen, frameStart);
    const decompressed = zstd.zstdDecompressSync(frameBuf, { maxOutputLength: maxDecompressed });
    if (decompressed.length > 0) onChunk(decompressed);
  }
}

/** Stream-decode a multi-frame .tar.zst file synchronously via an open fd. */
export function streamTarZstFileSync(
  fd: number,
  fileSize: number,
  handler: TarStreamHandler,
  options?: ZstdFrameReadOptions,
): void {
  const parser = new TarStreamParser(handler);
  forEachZstdFrameSync(fd, fileSize, (chunk) => parser.push(chunk), options);
  parser.finish();
}

/** Stream-decode any .tar.zst regular file asynchronously with O(chunkSize) memory. */
export async function streamTarZstFile(filePath: string, handler: TarStreamHandler): Promise<boolean> {
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return false;
    throw error;
  }
  let stat: fs.Stats;
  try {
    stat = fs.fstatSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* Ignore close error. */ }
    throw error;
  }
  if (!stat.isFile()) {
    fs.closeSync(fd);
    return false;
  }
  const parser = new TarStreamParser(handler);
  const readStream = fs.createReadStream('', { fd, autoClose: true, highWaterMark: ZSTD_STREAM_CHUNK_BYTES });
  const decompressor = zstd.createZstdDecompress({ chunkSize: ZSTD_STREAM_CHUNK_BYTES });
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        parser.push(chunk);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    final(callback) {
      try {
        parser.finish();
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  await pipeline(readStream, decompressor, sink);
  return true;
}
