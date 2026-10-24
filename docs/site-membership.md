# Site membership: admission, approval and bans

A site's admission mode is `open` (the default), `approval`, or `closed`.
New members become approved in open mode, pending in approval mode, and cannot
join in closed mode. Existing members can still sign in when admission closes.
Changing admission never changes existing member states, including pending members.

A site may also require a verified email (`users.site_member_verified_email`,
off by default). Then an account whose Naru email is not verified cannot sign
in to the site as a member, whether joining or returning; Naru's sign-in page
sends it to verify first. Tokens already issued keep working until they end.
The site never receives the address. Members need no supporter plan, unless
Naru's operators require one of a site's members (`users.site_members_free`
off; it is on by default). That is separate: supporters may be comp accounts
without a verified email, so a supporter plan does not imply one.

A site's owner may require a supporter plan of its members too
(`users.site_member_supporters_only`, off by default). It is checked like the
operators' requirement: at sign-in and on every request, so a member whose
support ends loses access without signing out.

Members are `pending`, `approved`, or `banned`. Only the signed-in site owner
can change admission or member states in the database control panel. Any state
can transition to either of the other states. IDs, roles and the site's data
remain intact; banning does not delete media, documents, the site's table rows,
payment records or durable work.
Collection-scoped SDK owner tokens do not grant membership administration.

Pending members can sign in and obtain a token. A request the site refuses them
for their standing fails with ACCESS_DENIED and `details: { membership:
"pending" }` (or `"banned"`), checked against current platform state, so the
application learns it from the request it was making anyway and can show an
approval screen. Approved members call the site's queries and mutations as
members, open member live connections, and upload. Pending and banned tokens
receive ACCESS_DENIED on queries, mutations, live tickets, and media
authorization/finalization. Existing tokens are checked on every request, so
changing state does not require signing in again; a member's open live
connections close (code 4003) when they stop being approved. Banned
members cannot obtain new sign-in codes or exchange previously issued codes.
They learn their state from their next refused request, and can sign out.
Unbanning permits existing unexpired tokens to work again.

Anonymous access remains governed by collection permissions and by what the
site's code allows visitors. A pending or banned person can omit their token and
access anything available to visitors; bans do not restrict public media URLs,
public collections, or visitors' queries and mutations. An upload URL already issued
before a ban cannot be recalled; finalization requires an approved member.
Requests already authorized before a state change may complete. This slice does
not attempt to coordinate in-flight Durable Object transactions with PostgreSQL.

The additive migration defaults existing members to approved and sites to open.
Deploy the migration before the new application; an ordinary rolling deployment
is sufficient. During the rollout, old application processes do not enforce bans;
only enable approval/ban controls once all processes run the new version.

Owner API: GET /api/account/site-members lists 100 members at a time with an
opaque member-id `nextCursor` (pass it as `after`). PATCH accepts either
`{ admission }`, `{ verifiedEmail }`, `{ supportersOnly }` or `{ id, status }`. It uses the owner's same-origin Naru session.
SDK 1.0.0 and the existing data-v1 response shapes remain unchanged.

neo-avocado's application membership documents are not automatically migrated.
Before removing its checks, map its approvals and bans to platform member states
and update its admission screen to read `error.details.membership`. Its board ACLs,
profile validation and business rules belong in its queries and mutations, with
levels and moderators kept as member roles (`ctx.member.roles`, `ctx.setRoles`).
