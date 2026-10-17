# SDK 1.1.0 media IDs and deletion

`member.media.upload()` and `admin.media.upload()` now return `id` alongside the
existing URL/name/contentType/size fields. Keep that ID with the document's URL.
SDK 1.0.0 bytes and upload results are unchanged.

```js
const uploaded = await member.media.upload(file);
await member.mutate("posts:write", {
  image: uploaded.url,
  imageId: uploaded.id,
});
// After the post no longer references the image:
await member.media.delete(uploaded.id, { signal });
```

Deletion resolves with no value, accepts a UUID file ID (never a URL), and does
not automatically retry. It is idempotent for an absent file within this site.
Members can delete only rows with their own stored member ID. Another member's
file, including owner uploads, returns ACCESS_DENIED. Normal token/site/origin
and membership checks apply: pending or banned tokens cannot delete media.
The control-panel owner retains full deletion authority.

Owner website handles require a new, explicit consent grant:

```js
await naru.auth.signIn({ collections: ["posts"], mediaDelete: true });
const admin = await naru.auth.session();
await admin.media.delete(id);
```

The Naru consent page states that this grant permits deletion of all site media,
including member uploads. Authorization codes and tokens store this flag; existing
and ordinary new owner tokens default to false. Changing token-exchange parameters
cannot add the grant. Revoke/signout/expiry and callback registration revocation
also revoke deletion authority. Listing files remains control-panel-only.

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

Abandoned pending uploads use the same durable path. Their cleanup claim checks
that they are still pending; finalization checks the tombstone again after storage
HEAD, so concurrent cleanup/delete cannot revive their metadata. Cleanup failures
retain the work and quota rather than losing track of an undeleted object.

The migration is additive. Apply it before rolling out the web application and
background jobs. Do not enable deletion controls until all processes run the new
version: old processes do not recognize tombstones or the new grant. Then release
naru-sdk, which serves the new committed SDK files at `sdk.naru.pub`. No payment records or unfinished
durable work are removed by the migration.

Application integration is separate: save IDs on new uploads, replace/remove the
referencing document first, and enqueue cleanup only when no retained reference
uses the file. Preserve IDs for retry/recovery; a browser-only cleanup call can be
lost when a tab closes before it is sent. Never infer IDs from external/legacy URLs.
This change does not migrate neo-avocado's existing images or add app reference
tracking. Moderators cannot delete another member's media through a member token;
that requires an explicitly authorized owner or a later server cleanup API.

Before deleting an upload by hand, the owner's media library shows whether
anything names it: collection documents (recorded as they are written) and the
site's own SQL tables (searched for the upload's URL or ID when the library
opens, with the table and column shown; docs/sdk-v1-api.md "Upload
references"). An upload marked 참조 없음 is named by neither, unless the
library says it searched only part of the tables. Site files and other sites
are not searched.
