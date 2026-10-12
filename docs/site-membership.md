# Site membership: admission, approval and bans

A site's admission mode is `open` (the default), `approval`, or `closed`.
New members become approved in open mode, pending in approval mode, and cannot
join in closed mode. Existing members can still sign in when admission closes.
Changing admission never changes existing member states, including pending members.

Members are `pending`, `approved`, or `banned`. Only the signed-in site owner
can change admission or member states in the database control panel. Any state
can transition to either of the other states. IDs and authored documents remain
intact; banning does not delete media, documents, payment records or durable work.
Collection-scoped SDK owner tokens do not grant membership administration.

Pending members can sign in and obtain a token. `member.membership()` returns
`{ id, status }`, checked against current platform state, so the application can
show an approval screen. Approved members receive the existing member permissions.
Pending and banned tokens receive ACCESS_DENIED on authenticated data requests,
function calls, and media authorization/finalization. Existing tokens are checked
on every request, so changing state does not require signing in again. Banned
members cannot obtain new sign-in codes or exchange previously issued codes.
They can inspect their state using an existing valid token and sign out.
Unbanning permits existing unexpired tokens to work again.

Anonymous access remains governed by collection permissions. A pending or banned
person can omit their token and access anything available to visitors; bans do
not restrict public media URLs or public collections. An upload URL already issued
before a ban cannot be recalled; finalization requires an approved member.
Requests already authorized before a state change may complete. This slice does
not attempt to coordinate in-flight Durable Object transactions with PostgreSQL.

The additive migration defaults existing members to approved and sites to open.
Deploy the migration before the new application; an ordinary rolling deployment
is sufficient. During the rollout, old application processes do not enforce bans;
only enable approval/ban controls once all processes run the new version.

Owner API: GET /api/account/site-members lists 100 members at a time with an
opaque member-id `nextCursor` (pass it as `after`). PATCH accepts either
`{ admission }` or `{ id, status }`. It uses the owner's same-origin Naru session.
The public status endpoint is GET /api/membership/v1/<site>, using a member Bearer
token and its bound Origin. Responses are never publicly cached. SDK 1.0.0 and
the existing data-v1 response shapes remain unchanged.

neo-avocado's application membership documents are not automatically migrated.
Before removing its checks, map its approvals and bans to platform member states
and update its admission screen to use `member.membership()`. Keep its board ACLs,
profile validation and transactional business rules until later SDK work replaces
them. Application roles, levels, rule hooks and guest functions are deferred.
