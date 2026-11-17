# 01: Read one try in place

**Status:** ready-for-agent
**Blocked by:** panel-tidy 02

**What to build:** Owner and architect, 2026-11-17: the owner's bottleneck is trying landed work; a waiting item is a
milestone try with several checks whose end matters as much as its title. In the Project hub's Waiting block (and from
Home's waiting rows), Enter on an item opens its whole text from STATE, scrollable, and Esc returns to the same row.

- [ ] The whole bullet as STATE writes it, continuation lines included, in its own order and words (no generated
      checklist, no model call).
- [ ] Long text scrolls with the movement keys and the wheel; Esc or a crumb click returns with the cursor on the item.
- [ ] Zero extra reads per refresh: the text comes from the STATE parse the hub already does (keep continuation lines
      in that parse if needed).
- [ ] Main-path frame test with a synthetic multi-line bullet at 38 columns, EN and ZH chrome.

## Comments
