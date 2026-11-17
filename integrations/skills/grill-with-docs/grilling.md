Adapted from mattpocock/skills `skills/productivity/grilling/SKILL.md` @5863806 (MIT). Owned here; not tracked against upstream.

Interview the owner relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every load-bearing decision in scope whose prerequisites are settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one plain-text round: number each question and give your recommended answer. Then wait for the owner's answers before the next round.

Format a round in plain text like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer. Limit questions to decisions that bear load in this scope; skip out-of-scope branches and trivia.

Each round the owner answers reshapes the tree: settled decisions push the frontier outward and unblock downstream questions. Recompute the frontier and ask the next round. Do not ask a question in this round if it depends on another open question.

Finding _facts_ is your job, never the owner's. Look up small facts yourself. For larger investigations, dispatch a HUD role through `hud-delegate` (pick the role from `hud_roster`); never use native subagents or background agents. Don't block on a running job: only questions downstream of it wait; ask the rest of the frontier now. Put _decisions_ to the owner and wait.

The session is done when the load-bearing frontier in scope is empty and the owner confirms shared understanding. Do not act on it before confirmation.
