Adapted from mattpocock/skills `skills/engineering/domain-modeling/SKILL.md` @5863806 (MIT). Owned here; not tracked against upstream.

# Domain Modeling

Actively build and sharpen the project's domain model as you design: challenging terms, inventing edge-case scenarios, and recording the glossary and decisions once the owner confirms them. (Merely *reading* `GLOSSARY.md` for vocabulary is a one-line habit any skill can do; this guide is for changing the model.)

## File structure

Most repos have a single context:

```
/
├── GLOSSARY.md
├── docs/
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
```

If a `GLOSSARY-MAP.md` exists at the root, the repo has multiple contexts pointing to each `GLOSSARY.md` and `docs/adr/`.

Create files lazily: only when the owner confirms something to write. Create `GLOSSARY.md` when the first term is confirmed, and `docs/adr/` when the first ADR is confirmed.

## During the session

### Challenge against the glossary

When a term conflicts with existing language in `GLOSSARY.md`, call it out immediately: "Your glossary defines 'cancellation' as X, but you seem to mean Y. Which is it?"

### Sharpen fuzzy language

When vague or overloaded terms come up, propose a precise canonical term: "You're saying 'account': do you mean Customer or User?"

### Discuss concrete scenarios

Stress-test domain relationships with edge-case scenarios that force precision about boundaries between concepts.

### Cross-reference with code

Check whether existing code agrees with stated rules. Surface contradictions immediately: "The code cancels entire Orders, while you described partial cancellation. Which is right?"

### Update GLOSSARY.md inline (main session only)

Once the owner confirms a resolved term, the main session updates `GLOSSARY.md` right there (never delegate glossary writes to a worker). Use [GLOSSARY-FORMAT.md](./GLOSSARY-FORMAT.md).

`GLOSSARY.md` must stay free of implementation details: it is a glossary, not a spec or scratch pad.

### Offer ADRs sparingly (main session only)

Only offer an ADR when all three are true:

1. **Hard to reverse**: changing your mind later has meaningful cost
2. **Surprising without context**: a future reader will ask "why did they do it this way?"
3. **Result of a real trade-off**: genuine alternatives existed and you picked one for specific reasons

If any of the three is missing, skip the ADR. The main session writes confirmed ADRs using [ADR-FORMAT.md](./ADR-FORMAT.md).
