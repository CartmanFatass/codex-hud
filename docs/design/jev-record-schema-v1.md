# Jev operation record schema v1

Protocol for the shared operation file written by the HUD ask path and read by the jev-ask CLI. Normative behavior for this package is `src/jev/ask/records.ts` and `src/jev/ask/lease.ts`. Design context is `docs/design/jev-in-hud.md` §4.5 (H1, H2, M1).

The CLI keeps unknown fields (it reads with `.get`). This writer does the same: a merge copies every key it does not understand, including explicit JSON `null`. It does not add `schema_version`.

## Paths

| File | Meaning |
|---|---|
| `state_dir/operations/<key'>.json` | One operation. `<key'>` is the key with `:` replaced by `_`. |
| `state_dir/operations/<key'>.<pid>.<hex>.tmp` | Unique temp file for one save. Removed by rename. Not the CLI's fixed `<key'>.tmp`. |
| `state_dir/browser.lock` | Browser lease for send and reconcile. |
| `state_dir/browser.lock.break` | Exclusive mutex held only while breaking a stale browser lease. |
| `state_dir/operations/<key'>.wait.lease` | Per-key wait lease. |
| `state_dir/operations/<key'>.wait.lease.break` | Mutex for breaking a stale wait lease. |
| `state_dir/chrome-headless` | Shared mode marker. Present means the running Chrome was started headless. |
| `state_dir/out/<key'>.*` | Answer and prompt files (D8). Not written by this package. |

`key` matches `^[A-Za-z0-9_.:-]{1,120}$`. The operations directory is created mode `0700`. Record files, lock files, and temp files are mode `0600`.

`state_dir` comes from `config.json` `jev.stateDir`, otherwise TOML `[jev] state_dir`. A blank value is an error. Loading config does not create the directory, the TOML path, the `config.json` path, or the credential path. Using a missing or non-directory `state_dir` (acquire, record write, or Chrome start) is `jev_state_dir_missing`. Callers create only `operations/`, and only with a non-recursive mkdir, then fsync `state_dir`. A bare JSON object is not treated as the `jev` table unless the caller sets `configJsonIsJev`.

## Key

```
key = PREFIX[provider] + sha256(json.dumps([label, sha256(strip(prompt))]))
```

| Provider | Prefix |
|---|---|
| chatgpt | `ask-pro:` |
| gemini | `ask-gemini:` |

`json.dumps` is CPython's default: separators `", "` and `": "`, `ensure_ascii` true. Characters outside 0x20–0x7E, and the controls `\b \f \n \r \t \" \\`, use those short escapes or `\uXXXX`. A non-BMP character is escaped as a UTF-16 surrogate pair (`\ud83d\ude00`), not as one `\u` of the code point. `/` is not escaped.

Prompt bytes are decoded as UTF-8 (invalid sequences are `prompt_encoding`), then Python universal newlines (`\r\n` and a lone `\r` become `\n`; U+0085, U+2028, and U+2029 stay), then `str.strip()`.

`pyStrip` and `pySquash` use Python `str.isspace` / `re` `\s`. The set is U+0009–U+000D, U+001C–U+001F, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000. U+FEFF is not in the set, so a BOM survives strip and is not a squash boundary. JavaScript `trim()` and `\s` are not used.

`squashed_sha256` is `sha256(squash(stripped prompt))` where squash is `re.sub(r'\s+', ' ', text or '').strip()`.

The public ask label must match `^[a-z0-9][a-z0-9-]{0,63}$` (`invalid_label`). `operationKey` still hashes any label the same way CPython does, so a non-slug label in an old file keeps its key. Fixture: `tests/fixtures/jev/ask-key-cross.json`.

Example, synthetic prompt `hello` (sha256 `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`), label `review-v2`:

```
ask-pro:fad35a78f2e7bcfd85712d26a137e291814a33c33266c424844fb92fc3ad71a8
```

That vector is the `controls` case after the leading and trailing U+001C / U+001F are stripped. The plain `review-v2` / `hello world` vector in the fixture is different.

## Record fields

JSON object, `JSON.stringify` indent 2, no required trailing newline. `updated` is the Python local timestamp `YYYY-MM-DDTHH:MM:SS±HHMM` (no colon in the offset), rewritten on every save.

| Field | Rule |
|---|---|
| `key`, `provider` | Set by send. A record with no `provider` is ChatGPT. A different provider is `provider_mismatch`. |
| `prompt_sha256` | Sha256 of the stripped prompt. A release write sets this to `null` and copies the old digest to `released_prompt_sha256`. Explicit `null` is kept. |
| `squashed_sha256` | Sha256 of the squashed prompt. |
| `conversation`, `mode`, `effort` | Copied from the ask. |
| `send_attempted` | Sticky. See below. |
| `send_effect` | `uncertain` at the click persist. Later `sent` or `not submitted`. |
| `released`, `released_evidence`, `released_prompt_sha256` | Set by the one reconcile release. |
| `unresolved` | Set when the outcome of a click is still open. |
| `attempts` | Newest-last log, capped at 20. `{ at, phase_reached, result, error?, evidence? }`. `result` is `pre_send`, `dry_run`, `uncertain`, or `sent`. |
| `tabs`, `pill_text` | New in v1. Shape of `tabs` is owned by the job package. |
| `dry_run`, `steps`, `sidebar_before`, `sent_target_id`, `conversation_url` | Existing CLI fields. Preserved when present. |
| any other key | Preserved. |

`conversation_url` and account-shaped text are masked only in printed results (`publicResult`). The file keeps them. This schema doc does not contain an address or an account.

### `send_attempted`

Once `true`, a later merge leaves it `true`. The only delta that clears it is one object that has both `released: true` and `send_attempted: false`. That is the reconcile release. A delta that omits `send_attempted`, or sets it `false` without `released: true`, does not clear it. `released: true` without `send_attempted: false` does not clear it either.

`assertCanSend`: `send_attempted` true → `already_attempted`. `released` true without `confirmResend` → `resend_needs_confirmation`.

### Writes (H1)

Send and reconcile take the browser lease before the first record read or write. Observation uses `readOperation` and does not take a lease. `readOperationLocked` checks the browser lease, then reads. A wait lease is `lease_required` for that read, for `persistClick`, and for `persistRelease`. A lease for another state directory is `lease_required`. Paths are compared with `path.resolve`, so a trailing slash is the same directory. A lease whose nonce is gone is `lease_lost`. Neither of those reads the record.

`mergeSave` and `appendAttempt` accept the browser lease or the wait lease for this same `state_dir` and key. That is how a wait records `conversation_url`, `completion`, `answer_sha256`, `partial_answer_chars`, `approvals`, and attempts without holding the browser lock (D4). A wait lease for a different key is `lease_required`.

Each save, under the lease that call accepts:

1. Re-read the file.
2. Merge the delta (sticky rule, attempt cap, drop `undefined`, keep `null` and unknown keys, set `updated`).
3. Create `<key'>.<pid>.<rand>.tmp` with `O_EXCL` (`wx`), mode `0600`.
4. Write, fsync the file, rename over the record, fsync the directory.

The click persist re-reads under the browser lease immediately before its write. If `send_attempted` is already true it throws `already_attempted` and does not create a temp file, rename, or fsync. Otherwise it writes `send_attempted: true`, `send_effect: "uncertain"`, and the caller's fields (`sent_target_id`, `sidebar_before`).

`persistRelease` is the reconcile release. It re-reads under the browser lease and writes `released: true` and `send_attempted: false` plus the caller's fields. If the disk has `send_effect === "sent"` it throws `already_sent` and does not write. If the disk has `released === true` it throws `already_released` and does not write. `mergeRecord` ignores a release delta (`released: true` and `send_attempted: false` together) when the disk already has `send_effect === "sent"`, and only refreshes `updated`.

A wait-lease save and a browser-lease save of the same key are not one critical section. Each re-reads, merges, and renames. The sticky `send_attempted` rule and the sent-release rule cover a release that sees `sent` on its re-read. v1 accepts one narrower window: a release that has already re-read, in the moment before a wait save writes `sent`, can still rename over that save. Closing it would need contradictory observations of the same record at the same moment. A later send of that key still requires `confirm_resend`.

## Browser lease (H2)

`browser.lock` and `browser.lock.break` are published by link, not by `wx` on the final name. Write `<file>.<pid>.<rand>.tmp` with `wx`, mode `0600`, fsync it, `link` that inode onto `<file>` (`EEXIST` means the name is busy), unlink the temp name, and fsync the directory. A name that exists is a complete body. Python can do the same with `os.link`.

One acquire call removes regular `*.tmp` and `*.stale` files in `state_dir` and in `operations/` whose mtime is more than one hour old. A host poll does not sweep again on each 250 ms attempt. A younger temp is a live save and is left alone. A takeover's `browser.lock.break.<pid>.<rand>.stale` (and the same shape for a wait lease) is unlinked once this process publishes its break file, loses that link with `EEXIST`, or restores the renamed inode. Those names are not the mutex. A crash, or a failed re-read of the renamed file, can leave one behind until the next acquire finds it older than an hour.

Body:

```json
{
  "nonce": "hex",
  "holder": "hud",
  "pid": 1,
  "pidns": "pid:[0]",
  "pidStart": "0",
  "jobId": "job",
  "phase": "send",
  "since": 0,
  "heartbeat": 0
}
```

`since` and `heartbeat` are epoch milliseconds. `holder` is `cli` or `hud`. `pidns` is `readlink /proc/self/ns/pid`. `pidStart` is field 22 of `/proc/<pid>/stat` (the token after the last `)` at index 19). The design's field list omitted `pidStart`; the stale rule needs it, so v1 stores it.

The holder rewrites `heartbeat` every 5 seconds by opening the lock `r+`, checking the nonce, writing at offset 0, truncating, and fsyncing. A rename or a replacement inode is not written. A nonce mismatch sets the lease lost and leaves the file alone. Any file error in that rewrite, including from the timer, sets the lease lost and does not throw. `release` on a lost lease leaves the file in place until a later acquire finds it stale (30 seconds, or a dead pid).

`release` reads the nonce and then unlinks. Those are not one step. A breaker can win between them. v1 accepts that window: the breaker re-reads the nonce and heartbeat before it unlinks, and the holder's next heartbeat sees the mismatch.

Stale when any of these hold:

- `heartbeat` is more than 30 seconds behind the clock (`>` 30000, so 30000 itself is still live).
- The lock's `pidns` equals this process's namespace and the pid does not exist (`ENOENT`).
- The same namespace and the pid's current start time differs from `pidStart`.
- The file is unreadable (it does not parse as a lock body) and its mtime is more than 30 seconds old (`>` 30000). A younger unreadable file is busy, not stale. An in-place heartbeat can tear; the write refreshes mtime, so the tear does not justify a break.

A different `pidns` is never treated as a dead pid. A probe error other than `ENOENT` is `unknown` and is not stale. A missing lock is not stale.

Breaking a stale lock:

1. Publish `browser.lock.break` by the link steps above. The body is `{ pid, pidns, pidStart, since }`.
2. If the name exists, take it over only when it is stale: rename it to `browser.lock.break.<pid>.<rand>.stale`, re-read that renamed file, and continue only when the bytes are the body just judged stale. One rename wins. If the bytes differ, restore that inode with `link` onto the break name (`EEXIST` leaves the newer file) and unlink the `.stale` name. Never `rename` it back over the break name. If the bytes match, publish this process's own break file by link. Unlink the `.stale` name after that publish, and also when that link loses with `EEXIST` (the newer file stays). A failed re-read of the renamed file leaves the `.stale` name for the hour sweep.
3. Re-read the lock. Unlink it only if the nonce and heartbeat are still the snapshot, or the unreadable bytes are still the snapshot.
4. Re-read after the new link and keep the lease only when the nonce is the one just written. On a mismatch, do not unlink the successor.
5. Unlink `browser.lock.break` only when its body is the one this process wrote. A successor's break file is left in place.

A live break file blocks the break. A parsed break file is stale when `since` is more than 30 seconds old, or when its pid is in this namespace and that pid is dead or its start time mismatches. An unreadable break file is stale only when its mtime is more than 30 seconds old. A different namespace is not treated as dead. The age check still applies across namespaces, so a crashed breaker cannot wedge the lock. The design text did not specify the break-file body; v1 records it so that rule can be checked.

The CLI calls the non-waiting acquire and returns `browser_busy` with `{ holder, phase, since }`. The host polls up to 10 minutes (`BROWSER_LOCK_WAIT_MS`) and then returns the same error. The library does not wait unless the caller passes `waitMs`.

The wait lease uses the same protocol. A second live waiter gets `{ role: "tail", observe: false, holder, phase, since, jobId }` and does not replace the nonce. If the lock disappears between the busy result and that re-read, the waiter tries once more to become the owner. Anything else that is not a live tail is `wait_busy`, not `browser_busy`. A stale wait lease can be broken, and the caller becomes the owner (`observe: true`).

## On-disk deviations from the design sentence

These are part of v1, recorded so the CLI port (J7) matches.

1. `pidStart` is stored on the lease. The stale rule in §4.5 requires the start time, and the published field list did not name a place to put it.
2. The break mutex file stores `{ pid, pidns, pidStart, since }`. It is published by link. A stale break file is taken over by rename. A mismatched rename is restored by `link`, which does not replace a newer break file. The `.stale` name is removed after that restore, after this process publishes its own break file, or when that publish loses with `EEXIST`. A process unlinks only the break body it wrote. An unreadable lock or break file is stale only when its mtime is more than 30 seconds old. A parsed break file may also be removed when that breaker is dead in this namespace, its start time mismatches, or `since` is older than 30 seconds.
3. Record and lock files are mode `0600`. The operations directory is mode `0700`.
4. Heartbeat updates are in-place `r+` writes. A rename would replace a successor's inode.
5. Clearing `send_attempted` requires `released: true` and `send_attempted: false` in the same delta.
