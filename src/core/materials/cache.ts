/** Provenance is kept beside, rather than inside, the pre-existing reply cache format. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fingerprint, type MaterialEnvelope } from './index.js';
import { writePrivateFile } from '../../collectors/small-model.js';

export class MaterialCache {
  constructor(private readonly dir: string | null) {}
  private readonly entries = new Map<
    string,
    { schemaVersion: 1; digest: string; at: number; envelope: MaterialEnvelope; reply: string }
  >();
  has(digest: string, envelope: MaterialEnvelope, text: string, at: number): boolean {
    let entry: unknown = this.entries.get(digest);
    if (this.dir) {
      try {
        const file = path.join(this.dir, 'materials-v1', `${digest}.json`);
        if (fs.statSync(file).size > 1024 * 1024) return false;
        entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return false;
      }
    }
    const proof = entry as
      { schemaVersion?: number; digest?: string; at?: number; envelope?: MaterialEnvelope; reply?: string } | undefined;
    return (
      proof?.schemaVersion === 1 &&
      proof.digest === digest &&
      proof.at === at &&
      proof?.envelope?.cacheDomain === envelope.cacheDomain &&
      fingerprint(proof.envelope.fragments) === fingerprint(envelope.fragments) &&
      proof.reply === fingerprint(text)
    );
  }
  remember(digest: string, envelope: MaterialEnvelope, text: string, at: number): void {
    const proof = { schemaVersion: 1 as const, digest, at, envelope, reply: fingerprint(text) };
    this.entries.set(digest, proof);
    while (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value!);
    if (this.dir) writePrivateFile(path.join(this.dir, 'materials-v1', `${digest}.json`), JSON.stringify(proof));
  }
}
