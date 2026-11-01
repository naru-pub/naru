# Naru Data SDK 1.1.0

A Naru site's pages store and read data in the site's own database with this SDK, imported from https://sdk.naru.pub/sdk/1.1.0/naru.js; there is nothing to install or build. The guides below are the ones people read on naru.pub, in Korean, with this site's name, "{{site}}", in their examples. Links in them are on {{origin}}.

## Building with these tools

- Choose where the data goes first: the "알맞은 곳" row of the table in section 02 of the database guide says when collections are enough and when the rules need site code. Section 12 has recipes for both.
- Declare the collections a page needs with configure_collections rather than asking the owner to make them on /database: it writes _naru/collections.json, and a new collection is created at once with the access given. A change to an existing collection's access waits for the owner's approval.
- Only the owner writes to a collection with "write": "admin", such as a blog's posts: through set_document when this connection may write documents, or through an admin page with naru.auth.signIn (section 05 of the database guide).
- Save site code's files with write_file: _naru/migrations/*.sql create the tables, and pages call _naru/queries/ and _naru/mutations/ with query() and mutate(). Saving installs them, and write_file says when it couldn't. No tool here calls them, so give the owner the page to try.
- After saving pages, give the owner the page's address to try it.
