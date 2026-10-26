# Media IDs and deletion

`member.media.upload()` and `admin.media.upload()` in SDK 1.1.0 return `id`
alongside the existing URL/name/contentType/size fields. A site keeps it with
the URL, for its own records and for `_naru_uploads`. SDK 1.0.0 bytes and
upload results are unchanged.

```js
const uploaded = await member.media.upload(file);
await member.mutate("posts:write", {
  image: uploaded.url,
  imageId: uploaded.id,
});
```

Pages never delete media: neither a member's handle nor an owner's website
sign-in can, and site code cannot either. Website tokens, the owner's and
members', may only upload (`/api/data/v1/<site>/_files`); any other method is
refused with ACCESS_DENIED. Deleting is the owner's, in the control panel's
media library (`/media`, which calls `/api/account/database/_files/<id>` with
the owner's session), for every upload of the site, members' included.
Account deletion removes the site's whole media prefix.

Development builds of SDK 1.1.0 once had `media.delete(id)` on both handles and
an owner sign-in option, `mediaDelete`, that asked the consent page for a
deletion grant. No site used them (checked against every site's files on
2026-10-25), so 1.1.0 ships without them. The grant's columns are dropped by
migration `1792901572129`; a cached SDK that still sends `mediaDelete=1` gets an
ordinary sign-in.

A DELETE records a durable tombstone before deleting storage. Tombstones disappear
from the media library and cannot be finalized again. Storage failure returns
UNAVAILABLE and retains the intent for the existing 15-minute cleanup job, or an
explicit retry. Byte quota is freed only after a successful storage deletion started after the
recorded upload URL expiry. New uploads reserve eleven minutes including a safety
margin; cleanup then retries at its next run. Older uploads can free bytes
immediately. Legacy rows use a conservative one-hour expiry from creation.
File-count and member-upload-limit accounting retain the row until cleanup.

Tombstones remain at least an hour. After that, cleanup deletes storage again before
removing metadata: bytes recreated through a recently expired presigned PUT are removed again. An old upload URL can temporarily recreate bytes before
cleanup, and previously cached public media URLs may remain visible. Deletion is
not an immediate revocation guarantee for copies or caches.

The `media-cleanup` job (`src/cli/cleanup-pending-media.ts`, every 15 minutes)
only finishes deletions the owner asked for. Nothing is deleted on Naru's own
judgement: an unfinished (pending) upload stays, marked in the media library,
until the owner deletes it, since its address may already be in use. A
deletion racing an upload's finalization wins: finalization checks the
tombstone again after storage HEAD, so it cannot revive the metadata. Cleanup
failures retain the work and quota rather than losing track of an undeleted
object.

If a site needs to delete its own uploads later, the place for it is site code
(a mutation that knows nothing still names the file), not the browser SDK.

Before deleting an upload by hand, the owner's media library shows whether
any collection document names it (recorded as documents are written;
docs/sdk-v1-api.md "Upload references"). An upload marked 문서 참조 없음 is
named by no document; the site's own SQL tables, its files and other sites
are not searched.
