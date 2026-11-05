# D3 stdin-only statusline preview

This independent first slice can be run without changing Claude settings:

```sh
npm run build
printf '%s' '{"model":{"display_name":"Claude"},"context_window":{"used_percentage":42},"cost":{"total_cost_usd":0.12}}' | node bin/hud-statusline-preview
```

Output: `Claude · ctx 42% · $0.12`.

Use `--width 48` to set the output width. Otherwise valid `COLUMNS`, TTY columns,
then 80 are used. Width is 1–500 terminal columns using the existing HUD width
convention. Cost, then context, are omitted when space is short. Model text is
escaped and truncated; unknown fields are omitted, and explicit zero is retained.
Only native `context_window.used_percentage` is displayed: no token totals or
model-name guesses are substituted for context occupancy.

The input must be one JSON object, at most 64 KiB of valid UTF-8. The input wait
has a one-second guard, not a hard real-time promise. Invalid input returns a
reason on stderr with empty stdout; input contents are never logged.

This is a preview, not the completed D3 integration or a default replacement.
It does not read files, collect transcripts, query delegation summaries, launch
processes, install configuration, or send data to a model. The existing second-line
delegation renderer is not connected here. Summary fallback, toktrack tee, the
shared `hud statusline` command, opt-in installation/restore and real Claude
compatibility validation remain separate work. No performance qualification is
claimed. All examples and tests use synthetic data.
