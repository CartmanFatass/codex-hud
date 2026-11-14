/** The panel's Project collectors: one per visited root, the panel's own never dropped, at most `max` in all. */
import type { ProjectCollector, ProjectSnapshot } from './project-board.js';

export class ProjectVisits {
  private readonly seen = new Map<string, { collector: ProjectCollector; snapshot?: ProjectSnapshot }>();
  constructor(readonly own: string, private readonly make: (root: string) => ProjectCollector, private readonly max = 4) {
    this.seen.set(own, { collector: make(own) });
  }
  /** The root's collector and its last snapshot; the newest visit, so the oldest other root is the one dropped. */
  visit(root: string) {
    const entry = this.seen.get(root) ?? { collector: this.make(root) };
    this.seen.delete(root);
    this.seen.set(root, entry);
    for (const key of [...this.seen.keys()]) {
      if (this.seen.size <= this.max) break;
      if (key !== this.own) this.seen.delete(key);
    }
    return entry;
  }
  /** The last snapshot of a root, without counting as a visit. */
  snapshot(root: string): ProjectSnapshot | undefined {
    return this.seen.get(root)?.snapshot;
  }
  get roots(): string[] {
    return [...this.seen.keys()];
  }
}
