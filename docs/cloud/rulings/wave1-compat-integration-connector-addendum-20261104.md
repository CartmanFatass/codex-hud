# Dependent integration: GitHub-connector construction addendum

Date: 2026-11-04. Clarification of the 2026-11-03 bounded dependent integration ruling. **No remote write or local checkout workload was performed for this consultation.**

## Decision

**Yes. Exact tree construction followed by real, ordered two-parent commits through the GitHub connector satisfies the three history-preserving qualification merges. A merge-branches API or local `git merge` invocation is not required.**

Git defines a commit with multiple parents as a merge of histories; the GitHub commit API supports a tree plus those parents. The tree still has to be proved correct: merely attaching two parents to an arbitrary selected tree is not a valid implementation of this ruling. [Git commit-tree](https://git-scm.com/docs/git-commit-tree), [GitHub commit objects](https://docs.github.com/en/rest/git/commits?apiVersion=2022-11-28).

Use only the requested connected GitHub tools. This clarifies the previous wording about an admitted preparation workspace: **a local worktree is not a prerequisite for connector-only source composition and verification.** No clone, checkout, local merge, install, build, test, process probe or controlled workload on a held executor is needed or authorized. The original executable-verification/resource holds remain unchanged.

The release is limited to `dots/wave1-compat-integration` and the three already pinned source lineages. It does not permit a source change, conflict resolution, acceptance, a `universal-hud` ref move, or resumption of the stopped evidence upload.

## Exact proof and write sequence

### 1. Pin inputs and reserve the sole destination

Read back the selected integration commit `U` and its tree, the three source commits/trees, and the current relevant branch refs. `U` is `88633ef53490f213b6ec987fdafec4f3fd1aa0a5`, or a specifically recorded later documentary-only successor satisfying the original ruling. Keep all current binding documents from `U`.

Pinned source order:

1. `P = b4047320262f72f401a513db07236ff1473db933` (HYG2 + NODE22-PROXY).
2. `M = b2897a4f9769bca6305ff0e3ae3dc694a9320ffe` (MCP-ANCESTOR R1).
3. `R = 7ba567ee0c3cd12933d79a5029162d32770ee245` (RUNZ1 + RUNZ1-KILL fix-1).

Confirm the destination branch is absent or explicitly owned by this same preparation. Never overwrite an unexpected branch. The supported create-branch operation may establish the absent branch at exact `U`; read it back before later updating it. Alternatively, a supported create-if-absent ref operation can publish the final verified commit directly. Do not treat a generic upsert as collision-safe, and do not use `force`.

### 2. Establish the conservative three-way result at every step

For each pair `(A, S)`, where `A` is the current accumulator and `S` is the next pinned source, record the connector's merge-base metadata and enough immutable ancestry to establish the applicable common base `B`. Expected bases for these unchanged histories are `f1e2a8408fbc6ddef181978e8a2d9fd5831242e9` for P, `26f6fba36948e6c96e2e109cb374c0d4dbb9ab22` for M, and `f1e2a8408fbc6ddef181978e8a2d9fd5831242e9` for R. Confirm them; do not guess them from package names. Stop on contradictory history, an unaccounted merge-base ambiguity, or a source already incorporated in a way inconsistent with the recorded plan.

Retrieve complete tree inventories for `B`, `A`, and `S`. A recursive tree response must be non-truncated; otherwise traverse its existing subtrees non-recursively until coverage is complete. Diff statistics or a possibly capped compare-file list alone do not establish this coverage. No blob download is needed for an unchanged Git object. [GitHub tree retrieval](https://docs.github.com/en/rest/git/trees?apiVersion=2022-11-28#get-a-tree).

For every leaf path, compare the complete entry `(mode, type, object SHA)`; absence is an explicit entry state. Compute the result by this closed rule:

- If `A[path] == S[path]`, keep that entry.
- Otherwise, if `A[path] == B[path]`, take `S[path]`.
- Otherwise, if `S[path] == B[path]`, keep `A[path]`.
- Otherwise, **stop: both sides changed this path differently**. Do not attempt text merging or pick a preferred side, even for documentation.

Check path-prefix/file-versus-directory collisions separately. Retain modes, symlinks and gitlink entries exactly where present. A rename is not permission for heuristic conflict resolution; handle the actual old/new path states and stop on a conflict. For this candidate, an unexpected deletion or mode/type change also requires a scope check before writing it.

This rule is intentionally narrower than a general Git merge engine. It is sufficient for the proved disjoint changes and identical overlapping entries selected here. There is no need to reproduce rename heuristics or invoke a merge driver. If the rule cannot express the actual result, this route is blocked at that path rather than licensed to improvise.

### 3. Create the exact tree using existing objects

Use `create_tree` with `base_tree_sha = A.tree` and only the precomputed delta, referencing existing object SHAs with their exact modes/types. Do not reconstruct source text with `content`, change line endings, or rebuild blobs unnecessarily. No new source blob is authorized.

Do not simultaneously supply a directory-tree entry and nested overrides beneath that directory. GitHub's tree API can replace such a subtree, so careless mixed entries may lose siblings. Sparse leaf deltas over the complete accumulator tree avoid that issue. [GitHub tree construction](https://docs.github.com/en/rest/git/trees?apiVersion=2022-11-28#create-a-tree).

Before creating the merge commit, read back the resulting tree completely and verify **equality to the entire predicted inventory**, not merely the changed-file subset. Verify every untouched path is retained, each expected change exists with its source object/mode/type, and no extra path/deletion appeared. Record the returned tree SHA and the inventory/delta.

### 4. Create and verify the three genuine merge commits

The commit graph must be exactly:

- `C1`: parents `[U, P]`, tree = proved result of U/P.
- `C2`: parents `[C1, M]`, tree = proved result of C1/M.
- `C3`: parents `[C2, R]`, tree = proved result of C2/R.

With the exposed connector, use `parent_sha = A` and `additional_parent_shas = [S]`. Each has exactly two parents in that order. Use clear WIP composition messages; do not claim tests or acceptance. This preserves source history and first-parent integration history without squashing, cherry-picking, rebasing, replacing source commits or using an octopus shortcut.

After each create, read the Git commit object back and verify its exact tree and ordered parents before continuing. Also confirm ancestry/compare metadata: the preceding accumulator and the corresponding source commit must be ancestors of the new merge, and the first-parent change must equal the planned delta. The connector-created object is the evidence; the requested parameter list alone is not.

### 5. Verify the final scope and protect the ref update

On `C3`, verify the original ruling's **26 implementation/test/source-document paths** have exactly the pinned owner blobs and modes. Verify every other implementation/configuration/dependency path equals `U`. Preserve current binding contracts and current integration documents.

One wording correction to the original ruling: “non-handoff delta” was too narrow for the permitted inherited documents. The unchanged source lineage also contains **`docs/cloud/rulings/hyg2.md`**, an existing reviewed ruling outside `docs/cloud/handoff/`. Its inclusion is permitted, byte-identical to the incoming source commit, and must be inventoried with the other inherited documentary additions. The implementation whitelist remains exactly 26 paths; this is not a code expansion. All inherited documentary paths must pass the same three-way proof. Do not overwrite a current document with an older package copy.

Keep new integration documentation commits separate from these three exact composition commits where practical. Record the final source candidate as `C3`; a later documentation-only branch head is a distinct identity whose source equivalence must be shown.

If the new branch was established at `U`, publish only verified `C3` with `update_ref(expected_sha = U, force = false)`. If it already contains this task's verified intermediate state, use that exact observed owned head as `expected_sha`, after checking the planned ancestry. There is no need to advance the branch after every object creation. Read the destination ref back after the successful update and verify it points exactly to the intended commit.

A rejection or uncertain write outcome is not permission to force, change destinations, or retry blindly. Inspect the known object/ref and reconcile the actual result first; stop the affected write if its outcome or ownership remains uncertain. Leave `main`, `universal-hud`, and all three source branch refs unchanged. Unexpected new non-documentary `universal-hud` drift remains a blocker under the original ruling.

## Minimum retained manifest

Record repository/destination, original destination state, `U/P/M/R` commits and trees, each applicable base, complete-tree coverage, the three predicted deltas, conflicts count zero, each returned tree/merge commit, exact ordered parents, final 26-path ownership verification, inherited-document inventory, ref-update expectation/result, and final remote read-back. State **builds/tests NOT RUN; candidate WIP, NOT ACCEPTED, NOT MERGEABLE**.

This is source/history verification, not a replacement for the already prescribed combined-tree or actual merged-tree tests. No new acceptance gate, second implementation review, compute lease or generic user approval is introduced by using the connector. The parent ruling's real-ancestor, benchmark, evidence-custody and final acceptance requirements remain unchanged.

**Final disposition: the connector-only three-way tree + ordered two-parent commit route is allowed for this exact qualification candidate when the proof above succeeds. No local checkout workload is required. No remote writes have been performed by this Oracle.**
