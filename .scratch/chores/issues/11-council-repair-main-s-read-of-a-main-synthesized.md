# 11: Council repair: main's read of a main-synthesized council records 'members collected by main'

**Status:** ready-for-agent
**Live try:** none
**Blocked by:** 08
**Objective:** unattended

**What to build:** Repair of chores/08 after milestone review jcb3010cb6270dbe6 (finding 1; read the report for file:line). In the ordinary sequence (hud_create council with synthesizer main, members finish, main calls hud_read), the detached runner (src/mcp/dispatch/council.ts ~110-126) closes the parent without a reason once the members settle. hud_read (src/mcp/mcp/operations.ts ~703-710) then skips settlement because the parent is already terminal, so 'members collected by main' is never recorded. Keep the detached completion and notification as they are (result ready without waiting for main). When main's hud_read returns the member digests and synthesis instructions, record the collection reason 'members collected by main' on a closed main-synthesized parent that has no reason yet. The stuck-parent path from chores/08 stays as it is.

- [ ] Ordinary sequence create -> members settle -> hud_read records reason 'members collected by main' on the parent (test)
- [ ] The existing stuck-parent and detached-completion tests still pass

## Comments
