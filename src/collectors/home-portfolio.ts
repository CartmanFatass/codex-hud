import * as fs from 'node:fs';
import { join } from 'node:path';
import type { ListedProject } from '../roles/projects.js';
import { readFileBounded } from '../utils/atomic-fs.js';
import { resultExcerpt, type ObjectiveRecord } from './objectives.js';
import { compareOwnerRequests, ProjectCollector, projectJobWindow, type ProjectItem, type ProjectSnapshot } from './project-board.js';
import type { WorkboardSnapshot } from './workboard-types.js';

interface Result { text: string; at?: number }
interface ResultReceipt { project: string; id: string; at: number; result?: string }
export interface HomeProject extends ListedProject { snapshot?: ProjectSnapshot; result?: Result }
export interface HomeRequest { project: HomeProject; item: ProjectItem; index: number }
export interface HomePortfolio { projects: HomeProject[]; requests: HomeRequest[] }

/** Keep the newest year of monthly receipts, at most 64 KiB from the tail of each month. */
class ResultReceipts {
  private months: string[] = [];
  private dirStamp?: string;
  private cache = new Map<string, { stamp: string; receipts: ResultReceipt[] }>();
  constructor(private dir: string) {}

  read(): Map<string, ResultReceipt> {
    const latest = new Map<string, ResultReceipt>();
    try {
      const dir = fs.lstatSync(this.dir, { throwIfNoEntry: false });
      const stamp = dir?.isDirectory() ? `${dir.ino}:${dir.mtimeMs}:${dir.ctimeMs}` : '';
      if (stamp !== this.dirStamp) {
        this.months = stamp ? fs.readdirSync(this.dir).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort().slice(-12) : [];
        this.dirStamp = stamp;
        for (const name of this.cache.keys()) if (!this.months.includes(name)) this.cache.delete(name);
      }
    } catch { return latest; }
    for (const name of this.months) {
      const file = join(this.dir, name);
      let st: fs.Stats | undefined;
      try { st = fs.lstatSync(file, { throwIfNoEntry: false }); } catch { continue; }
      if (!st?.isFile()) continue;
      const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
      let entry = this.cache.get(name);
      if (entry?.stamp !== stamp) {
        const receipts: ResultReceipt[] = [];
        try {
          const limit = 65536, offset = Math.max(0, st.size - limit);
          const lines = readFileBounded(file, limit, { offset }).bytes.toString('utf8').split('\n');
          lines.pop(); // The writer terminates every complete receipt with a newline.
          if (offset) lines.shift();
          for (const line of lines) try {
            const e = JSON.parse(line);
            if (e?.v !== 1 || e.kind !== 'objective' || !['created', 'result'].includes(e.change) ||
                typeof e.project !== 'string' || typeof e.id !== 'string' || typeof e.at !== 'string') continue;
            const at = Date.parse(e.at);
            if (Number.isFinite(at) && new Date(at).toISOString() === e.at)
              receipts.push({ project: e.project, id: e.id, at, result: typeof e.result === 'string' ? e.result : undefined });
          } catch { /* A malformed line does not hide the rest of the file. */ }
        } catch { /* Unavailable month: no result dates from it. */ }
        this.cache.set(name, entry = { stamp, receipts });
      }
      for (const e of entry.receipts) {
        const key = JSON.stringify([e.project, e.id]);
        if ((latest.get(key)?.at ?? -Infinity) <= e.at) latest.set(key, e);
      }
    }
    return latest;
  }
}

const priorities: Record<ObjectiveRecord['priority'], number> = { high: 1, normal: 0, low: -1 };

/** A separate bounded pool: Project visits don't evict Home's file/rollup memos, and Home does not mark a visit. */
export class HomePortfolioCollector {
  private pool = new Map<string, ProjectCollector>();
  private receipts: ResultReceipts;
  constructor(private home: string) { this.receipts = new ResultReceipts(join(home, 'events')); }

  async read(list: readonly ListedProject[], board: WorkboardSnapshot, now: number): Promise<HomePortfolio> {
    for (const root of this.pool.keys()) if (!list.some((p) => p.root === root && !p.unavailable)) this.pool.delete(root);
    const projects: HomeProject[] = [];
    let jobs: ReturnType<typeof projectJobWindow> | undefined;
    for (const project of list) {
      if (project.unavailable) { projects.push(project); continue; }
      const collector = this.pool.get(project.root) ?? new ProjectCollector(project.root, this.home);
      this.pool.set(project.root, collector);
      projects.push({ ...project, snapshot: await collector.collect('home', board, now, jobs ??= projectJobWindow(this.home)) });
    }
    if (projects.some((p) => p.snapshot?.objectives?.objectives.some((o) => o.result))) {
      const receipts = this.receipts.read();
      for (const project of projects) for (const { id, result } of project.snapshot?.objectives?.objectives ?? []) {
        if (!result) continue;
        const receipt = receipts.get(JSON.stringify([project.root, id]));
        const at = receipt?.result === resultExcerpt(result) ? receipt.at : undefined;
        if (!project.result || (at ?? -Infinity) > (project.result.at ?? -Infinity)) project.result = { text: result, at };
      }
    }
    const priority = (p: HomeProject) => priorities[p.snapshot?.objectives?.priority ?? 'normal'];
    const requests = projects.flatMap((project) => project.snapshot?.waiting.map((item, index) => ({ project, item, index })) ?? []);
    requests.sort((a, b) => compareOwnerRequests(a.item, b.item, priority(a.project), priority(b.project)));
    return { projects, requests };
  }
}
