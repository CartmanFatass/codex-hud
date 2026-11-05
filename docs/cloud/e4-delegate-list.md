# Owner-scoped delegate_list

`delegate_list` accepts optional `limit` (1–50, default 20) and `cursor`. It returns
latest-run summaries for the authenticated MCP owner's links, including historical
same-session links across caller instances. It does not list other owners' links,
count them, or grant control over them. Local-user enumeration is not supported.

Each call validates the current scope/context, including an empty page. Candidate
links are filtered by full owner identity before the page limit; each returned link
also passes the existing delegation-read authorization. Cursors bind ledger identity,
owner, context ID/generation and the versioned list contract. They are pagination
positions, not capabilities. A changed context requires a fresh first page.

Ordering is `(created_at, link_id)`. Pages are ordinary observations, not a frozen
snapshot across requests: concurrent inserts before a cursor may require restarting
from the first page. Lifecycle is read from one ledger snapshot; status is selected
from existing committed observation projections using their original stamps. Missing
or stale observation stays explicit. No transcript reading, launch, cancellation,
report submission, close/send/ask operation, or observation publication occurs.

Responses omit brief/report paths, report text, labels, raw transcript contents,
claims and global counts. `currentOwner` describes the recorded link, not a new
authorization grant. Tests are synthetic ledger/MCP contract checks, not live-client
or managed capability qualification.
