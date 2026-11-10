/** Materialized binding, validated by the release-independent plugin bootstrap. No credentials. */
export interface ClaudeBinding {
  version: 1;
  release: string;
  digest: string;
  releaseVersion: string;
  node: string;
  hudHome: string;
  parityInventory: string | null;
}
