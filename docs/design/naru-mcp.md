# Naru MCP

Apps that speak the Model Context Protocol connect to an account's site at
`https://naru.pub/mcp` and read and change its files. It is a supporter
feature (`mcp` in `lib/entitlements.ts`), like the other automated ways to
publish (GitHub App and CI deploys). People find it on `/account` and
`/docs/mcp`; naru.pub doesn't promote it elsewhere.

## What a connection reaches

One site: the account's own files, through the same keys, limits and
follow-up work as the file manager (`lib/mcp/site-files.ts`): 10 MB per file,
the file manager's extensions, `index.html` never deleted or moved, the site
title from `index.html`, edit stats, and the cache purge, which also installs
`_naru/` declarations and site code. Nothing else: no account settings,
billing, custom domains or site database.

| Tool          | Scope   | Does                                               |
| ------------- | ------- | -------------------------------------------------- |
| `get_site`    | `read`  | address, title, last change, plan end, file limits |
| `list_files`  | `read`  | files under a folder, at most 2000                 |
| `read_file`   | `read`  | text and images up to 1 MB; others by address      |
| `write_file`  | `write` | create or replace a file (utf8 or base64)          |
| `move_file`   | `write` | move or rename; refuses to overwrite               |
| `delete_file` | `write` | delete one file                                    |

A connection without `write` isn't offered the last three. Tool text is in
English, for the models that read it, and says only what Naru is.

Database tools are left for later: a site's collections hold text visitors
wrote, and a model that reads it while able to write files can be steered
by it. They need their own scope, with visitor-written documents marked as
data, before they are added.

## Signing in

OAuth 2.1 as the MCP authorization spec describes it (`lib/mcp/oauth.ts`):

1. `/mcp` answers a request without a valid token with 401 and
   `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`
   (RFC 9728), which names naru.pub as the authorization server; its
   metadata is at `/.well-known/oauth-authorization-server` (RFC 8414).
2. The app registers at `/api/mcp/oauth/register` (RFC 7591), open to
   anyone. Registrations are public clients (`token_endpoint_auth_method:
none`); redirect URIs are https, loopback http (RFC 8252 §7.3) or a
   private-use scheme (§7.1), never `javascript:`-like schemes, since the
   consent page navigates to them. Registrations no sign-in used are pruned
   after a day; at most 500 are accepted an hour.
3. The person opens `/mcp/authorize`, signs in on `/login` if needed, sees
   the app's self-declared name next to the host it returns to, keeps or
   drops `write`, and approves. Accounts without the feature are pointed to
   `/supporter`.
4. The app exchanges the code (PKCE S256, 10 minutes, one use) at
   `/api/mcp/oauth/token` for a 1-hour access token and a refresh token.

### Tokens and the threat model

The risk is one connection's token leaking: it can rewrite or delete the
site. Access tokens go out with every request and live in other parties'
servers, logs and config files; refresh tokens go only to the token
endpoint. So access tokens last an hour, and each refresh replaces both.
The grant keeps the replaced refresh token's hash
(`previous_refresh_hash`): presenting it again means two parties hold the
connection, and the grant is deleted, ending the attacker's tokens along
with the app's (OAuth 2.1 §4.3.1). An app that retries a refresh whose
answer it lost is signed out the same way; the person connects again.

Every request looks the grant up, so revoking on `/account` takes effect at
once. A grant unused for 30 days can't be refreshed. The account losing the
plan keeps its grants but every tool answers that the plan is needed.

## Transport

Streamable HTTP without sessions (`app/(main)/mcp/route.ts`): each POST gets
a server and transport of its own and a JSON answer, so either blue/green
process can take any request and nothing is held between them. GET and
DELETE answer 405. Each grant may make 120 requests a minute per process.
CORS is open on the metadata, registration, token and MCP endpoints, which
read no cookies.

## Not yet

- An undo history for changes made through MCP.
- Database tools (see above).
