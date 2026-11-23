import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const LINE_CAP = 40, BYTE_CAP = 8 * 1024;
const tabs = /^\s*(?:Home|首页)(?:\s+\?\d+)?\s+(?:Project|项目)(?:\s+\?\d+)?\s+(?:Control|控制)(?:\s+EXP)?(?:\s+(?:models off|模型 关))?$/;
const footer = /\? (?:help|帮助)\s*$/;
const afterFrame = /^\s*(?:at\s|test at |not ok \d|✖ |(?:error|code|name|expected|actual|operator|diff|stack|generatedMessage):|\.\.\.$|}$)/;
const location = (line: string) => /^(.*?):\d+(?::\d+)?$/.exec(line)?.[1];

function clip(line: string, cap: number, fromEnd = false) {
  const bytes = Buffer.from(line);
  if (bytes.length <= cap) return line;
  let edge = fromEnd ? bytes.length - cap : cap;
  while ((bytes[edge] & 0xc0) === 0x80) edge += fromEnd ? 1 : -1;
  return (fromEnd ? bytes.subarray(edge) : bytes.subarray(0, edge)).toString().trimEnd();
}

type Block = { kind: 'spec' | 'tap'; lines: string[]; bytes: number; file?: string; name?: string; assertion?: number };

/** Capture assertion blocks as they arrive; a long frame or trailing output must not evict them. */
export class LandOutput {
  private recent: string[] = [];
  private blocks: Block[] = [];
  private first = new Map<string, Block>();
  readonly files = new Set<string>();
  readonly tests = new Set<string>();

  constructor(private cwd: string) {}

  private localFile(path: string | undefined) {
    if (!path) return;
    let file: string;
    try { file = relative(this.cwd, path.startsWith('file://') ? fileURLToPath(path) : resolve(this.cwd, path)); }
    catch { return; }
    if (file && file !== '..' && !file.startsWith(`..${sep}`) && !isAbsolute(file)) return file;
  }

  stream() {
    let frame = false, block: Block | undefined;
    const finish = () => {
      const file = block?.file;
      if (file && block?.kind === 'spec') this.files.add(file);
      if (block?.name) {
        const name = clip(block.name, BYTE_CAP / 4);
        this.tests.add(file ? `${name} (${file})` : name);
        if (file && !this.first.has(file) && this.first.size < LINE_CAP) this.first.set(file, block);
        if (this.blocks.length < LINE_CAP) this.blocks.push(block);
      } else if (file) this.tests.add(file);
      block = undefined;
    };
    const start = (kind: Block['kind'], line: string, file?: string, name?: string) => {
      const head = clip(line, BYTE_CAP / 4);
      block = { kind, lines: [head], bytes: Buffer.byteLength(head), file, name };
    };
    return { finish, line: (raw: string) => {
      const line = stripVTControlCharacters(raw).trimEnd();
      if (!line) return;
      if (tabs.test(line)) { frame = true; return; }
      if (frame) {
        if (footer.test(line)) { frame = false; return; }
        if (!afterFrame.test(line) && /^\s/.test(line)) return;
        frame = false;
      }
      const tailLine = clip(line, BYTE_CAP, true);
      if (tailLine.trim()) this.recent.push(tailLine);
      if (this.recent.length > LINE_CAP) this.recent.shift();
      const specPath = line.startsWith('test at ') ? location(line.slice(8)) : undefined;
      const tapName = /^\s*not ok \d+ - (.+)$/.exec(line)?.[1];
      if (specPath || tapName) {
        finish();
        if (specPath) start('spec', line, this.localFile(specPath));
        else start('tap', line, undefined, tapName);
        return;
      }
      if (!block) return;
      if (block.kind === 'spec' && !block.name) {
        block.name = /^\s*✖ (.+?)(?: \([\d.]+ms\))?$/.exec(line)?.[1];
        if (!block.name) { finish(); return; }
      } else if (!/^\s/.test(line)) { finish(); return; }
      if (block.kind === 'tap') {
        const field = /^\s+location: ['"]?(.+?)['"]?$/.exec(line)?.[1];
        if (field) block.file = this.localFile(location(field));
        if (block.assertion === undefined && /^\s+error:/.test(line)) block.assertion = block.lines.length;
      } else if (block.lines.length === 2) block.assertion = 2;
      // Keep room for the TAP assertion even if it follows oversized YAML metadata.
      const saved = clip(line, BYTE_CAP / 4) || clip(line.trimStart(), BYTE_CAP / 4);
      const bytes = Buffer.byteLength(saved) + 1;
      if ((block.bytes + bytes <= BYTE_CAP && block.lines.length < LINE_CAP) ||
          block.assertion === block.lines.length || (block.kind === 'tap' && block.assertion === block.lines.length - 1)) {
        block.lines.push(saved); block.bytes += bytes;
      }
      if (block.kind === 'tap' && /^\s+\.\.\.$/.test(line)) finish();
    } };
  }

  tail() { return [...this.recent]; }

  evidence() {
    const tests = [...this.tests], files = [...this.files];
    // Reserve names and assertion messages before spending either limit on stacks and diffs.
    const blocks = [...new Set([...this.first.values(), ...this.blocks])];
    if (!blocks.length) {
      const excerpt = clip(this.recent.join('\n'), BYTE_CAP, true);
      return { tail: excerpt ? excerpt.split('\n') : [], excerpt, tests, files };
    }
    let lines = 0, bytes = 0;
    const picked = new Map(blocks.map(block => [block, new Set<number>()]));
    const take = (block: Block, indices: number[]) => {
      const selected = picked.get(block)!;
      const add = indices.filter(i => i < block.lines.length && !selected.has(i));
      const size = add.reduce((sum, i) => sum + Buffer.byteLength(block.lines[i]) + 1, 0);
      if (lines + add.length > LINE_CAP || bytes + size > BYTE_CAP + 1) return false;
      for (const i of add) selected.add(i);
      lines += add.length; bytes += size;
      return true;
    };
    const core = (block: Block) => {
      const head = block.kind === 'spec' ? [0, 1] : [0];
      const i = block.assertion;
      if (i !== undefined) {
        head.push(i);
        if (block.kind === 'tap' && /[|>][-+]?\s*$/.test(block.lines[i])) head.push(i + 1);
      }
      return head;
    };
    const required = new Set([...this.first.values(), ...this.blocks.filter(block => !block.file)]);
    for (const block of blocks) {
      if (take(block, core(block)) || !required.has(block)) continue;
      // Many files or very long assertions: give each file one line rather than losing later files.
      const compact = blocks.slice(0, LINE_CAP);
      const cap = Math.floor((BYTE_CAP + 1) / compact.length) - 1;
      const tail = compact.map(b => {
        const title = b.lines[b.kind === 'spec' ? 1 : 0].trim();
        const assertion = core(b).filter(i => b.assertion !== undefined && i >= b.assertion)
          .map(i => b.lines[i]?.trim()).filter(Boolean).join(' ');
        const half = Math.floor(cap / 2);
        return assertion ? `${clip(title, half)}: ${clip(assertion, cap - half - 2)}` : clip(title, cap);
      });
      return { tail, excerpt: tail.join('\n'), tests, files };
    }
    for (const block of blocks) {
      if (!picked.get(block)!.size) continue;
      for (let i = 0; i < block.lines.length; i++) if (!take(block, [i])) break;
    }
    const tail = blocks.flatMap(block => [...picked.get(block)!].sort((a, b) => a - b).map(i => block.lines[i]));
    return { tail, excerpt: tail.join('\n'), tests, files };
  }
}
