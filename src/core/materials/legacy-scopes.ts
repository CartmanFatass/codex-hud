/** Output-bound influence scope for legacy recaps; old fingerprints alone are not ancestry proof. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writePrivateFile } from '../../collectors/small-model.js';
import type { Recap } from '../../collectors/recap.js';
import { fingerprint } from './index.js';
const outputFingerprint = (recap: Recap) =>
  fingerprint([
    recap.sessionId,
    recap.at,
    recap.language,
    recap.coveredUntil,
    recap.goal,
    recap.done,
    recap.now,
    recap.needs,
    recap.fingerprint,
    recap.floorFingerprint,
    recap.overall,
  ]);
export class LegacyRecapScopes {
  constructor(private readonly dir: string | null = null) {}
  private readonly scopes = new Map<string, { output: string; scope: 'main' | 'broad' }>();
  private key(recap: Recap): string {
    return fingerprint(['legacy-recap-scope-v1', recap.sessionId, recap.at]);
  }
  save(recap: Recap, scope: 'main' | 'broad'): void {
    const key = this.key(recap);
    const proof = { schemaVersion: 1, key, output: outputFingerprint(recap), scope };
    this.scopes.set(key, proof);
    while (this.scopes.size > 200) this.scopes.delete(this.scopes.keys().next().value!);
    if (this.dir) writePrivateFile(path.join(this.dir, `${key}.json`), JSON.stringify(proof));
  }
  /** Called only inside an authorized formatter, outside the HUD tick. */
  fitsMain(recap: Recap): boolean {
    const key = this.key(recap);
    let proof: { schemaVersion?: number; key?: string; output?: string; scope?: string } | undefined;
    if (this.dir) {
      try {
        const file = path.join(this.dir, `${key}.json`);
        if (fs.statSync(file).size > 1024) return false;
        proof = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return false;
      }
    } else {
      const cached = this.scopes.get(key);
      if (cached) proof = { ...cached, schemaVersion: 1, key };
    }
    return (
      proof?.schemaVersion === 1 &&
      proof.key === key &&
      proof.scope === 'main' &&
      proof.output === outputFingerprint(recap)
    );
  }
}
