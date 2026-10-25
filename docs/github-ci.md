# GitHub CI Deploys

Naru supports GitHub Actions deploys through GitHub Actions OIDC. Users register
an allowed repository/ref in Naru, then a workflow uploads a generated static
site into a staging prefix and finalizes the deployment.

GitHub CI deploys are available to supporter accounts.

A site whose files are served as they are in the repository does not need a
workflow: connecting the repository on `/github` deploys it on every push
through Naru's GitHub App ([github-app.md](github-app.md)). Workflows are for
sites that need a build step. A site folder is deployed by one target only: a workflow
target cannot share or nest with another target's folder, an App target's
included.

Recommended official Action repository name: `naru-pub/deploy-action`.
If Naru expects to publish multiple official actions, `naru-pub/actions` with
the deploy action at `naru-pub/actions/deploy@v1` is also a good shape.

## Flow

1. The Action requests a GitHub OIDC token with audience
   `https://naru.pub` or `GITHUB_DEPLOY_AUDIENCE`.
2. `POST /api/deploy/github/plan`
   - verifies the OIDC token,
   - finds a matching enabled deploy target,
   - validates the manifest,
   - creates a planned deployment,
   - returns signed R2 upload URLs for staging keys.
3. The Action uploads every manifest file to the returned staging URLs.
4. `POST /api/deploy/github/finalize`
   - verifies the OIDC token again,
   - checks staged object size and checksum metadata,
   - copies staged objects into the public user prefix,
   - deletes files previously managed by the same target when configured,
   - updates `site_updated_at`, `site_title`, deployment manifest, and home
     directory size,
   - purges Cloudflare cache,
   - when the commit changes the site's code (`_naru/`), publishes its
     release and answers `functions: { status: "activating" }` without
     waiting: activation applies the release's migrations after a restore
     point, which can outlast Cloudflare's 100-second limit on the request.
     The release activates in its durable task (`function-release-v1`).
5. `POST /api/deploy/github/status` with the same `deploymentId`, until
   `functions.status` is `active`, or `refused` with `functions.error`
   (`{ message, details }`, as a 422 `migration_failed`): the files are
   published either way, and a refused release leaves the previous code
   active. `functions` is null when the commit changed no site code.

Finalize is the publish step. If it is skipped, uploaded objects remain in the
staging prefix and do not change the public site.

The staging prefix, `__deploy_uploads/<user id>/<deployment id>/`, is in the
site bucket, which `r2.naru.pub` serves to anyone who knows a key. Staged files
are not private: the two random ids are what keep them from being found.

## Workflow Shape

```yaml
name: Deploy to Naru

on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install && pnpm build
      - uses: naru-pub/deploy-action@v1
        with:
          site: my-naru-login
          dir: dist
          target: /
```

The target must be registered in Naru before this workflow can deploy.

## Template Versions

A board template whose versions come from GitHub Actions (its edit page)
publishes through the same three calls with `templateOwner` (the Naru account
that posted it) and `folder` (the repository folder its post names), or
`template: <template id>`, and `changelog` (the commit message), in place of
`site` and `targetPrefix`. With no matching template yet, plan answers
`{ skipped: true, message }` and the action finishes successfully. The
token must name the template's repository and ref. Plan answers uploads only
for files the previous version lacked by sha256; finalize copies the rest from
that version, refuses site code that does not parse, publishes the next
version and answers `{ version, functions: null }`: the code runs on the sites
that install it, not here. Status answers the upload's state. See
[board.md](board.md), "Where versions come from".
