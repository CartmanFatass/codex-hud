/** Minimal POSIX ustar/PAX tar + Node 24 built-in zstd container for cold archives. */
import * as zlib from 'node:zlib';

const BLOCK = 512;
const MAX_USTAR_NAME = 100;
const MAX_USTAR_SIZE = 0o77777777777; // 8 GiB - 1
const DEFAULT_MAX_DECOMPRESS_BYTES = 128 * 1024 * 1024;

type ZstdLib = typeof zlib & {
  zstdCompressSync: (buf: zlib.InputType, options?: { params?: Record<number, number> }) => Buffer;
  zstdDecompressSync: (buf: zlib.InputType, options?: { maxOutputLength?: number }) => Buffer;
};
const zstd = zlib as ZstdLib;

export interface TarEntry {
  name: string;
  data: Buffer;
  mode?: number;
  mtime?: number;
}

export function isSafeTarPath(name: string): boolean {
  if (!name || name.startsWith('/') || name.includes('\0') || name.includes('\\')) return false;
  const parts = name.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
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

export function encodeTar(entries: readonly TarEntry[]): Buffer {
  const seen = new Set<string>();
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    if (!isSafeTarPath(entry.name)) throw new Error(`invalid_tar_path:${entry.name}`);
    if (seen.has(entry.name)) throw new Error(`duplicate_tar_path:${entry.name}`);
    seen.add(entry.name);
    const mode = entry.mode ?? 0o600;
    const mtime = entry.mtime !== undefined && Number.isFinite(entry.mtime) ? Math.max(0, Math.floor(entry.mtime)) : 0;
    if (needsPax(entry.name, entry.data.length)) {
      const records: Buffer[] = [paxRecord('path', entry.name)];
      if (entry.data.length > MAX_USTAR_SIZE) records.push(paxRecord('size', String(entry.data.length)));
      const paxData = Buffer.concat(records);
      const paxName = `PaxHeader/${seen.size}`;
      chunks.push(buildHeader(paxName, paxData.length, 0o600, mtime, 'x'), paxData, padBlock(paxData.length));
    }
    const shortName = Buffer.from(entry.name, 'utf8').length <= MAX_USTAR_NAME
      ? entry.name
      : entry.name.replace(/[^\x20-\x7e]/g, '_').slice(0, MAX_USTAR_NAME);
    chunks.push(buildHeader(shortName, entry.data.length, mode, mtime, '0'), entry.data, padBlock(entry.data.length));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
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

export function decodeTar(buf: Buffer): TarEntry[] {
  if (buf.length % BLOCK !== 0) throw new Error('invalid_tar_alignment');
  const entries: TarEntry[] = [];
  let offset = 0;
  let pax: Record<string, string> | null = null;
  let gnuLongName: string | null = null;
  while (offset < buf.length) {
    if (isZeroBlock(buf, offset)) break;
    const header = buf.subarray(offset, offset + BLOCK);
    verifyChecksum(header);
    const type = String.fromCharCode(header[156]!);
    const mode = readOctal(header, 100, 8);
    const mtime = readOctal(header, 136, 12);
    const headerSize = readOctal(header, 124, 12);
    const size = pax?.size !== undefined ? Number(pax.size) : headerSize;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid_tar_size');
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new Error('truncated_tar_entry');
    const data = Buffer.from(buf.subarray(dataStart, dataEnd));
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    offset = dataStart + padded;

    if (type === 'x') {
      pax = parsePax(data);
      continue;
    }
    if (type === 'L') {
      const nul = data.indexOf(0);
      gnuLongName = (nul === -1 ? data : data.subarray(0, nul)).toString('utf8');
      continue;
    }
    const rawName = readString(header, 0, MAX_USTAR_NAME);
    const prefix = readString(header, 345, 155);
    const name = pax?.path ?? gnuLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pax = null;
    gnuLongName = null;
    if (type === '5') continue; // Ignore explicit directory headers.
    if (type !== '0' && type !== '\0') throw new Error(`unsupported_tar_type:${type}`);
    if (!isSafeTarPath(name)) throw new Error(`unsafe_tar_path:${name}`);
    entries.push({ name, data, mode, mtime });
  }
  return entries;
}

export function encodeTarZst(entries: readonly TarEntry[]): Buffer {
  return zstd.zstdCompressSync(encodeTar(entries));
}

export function decodeTarZst(zst: Buffer, maxOutputLength = DEFAULT_MAX_DECOMPRESS_BYTES): TarEntry[] {
  return decodeTar(zstd.zstdDecompressSync(zst, { maxOutputLength }));
}
