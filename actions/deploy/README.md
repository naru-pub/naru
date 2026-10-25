# Deploy to Naru

Deploy a static site directory to Naru from GitHub Actions.

This action uses GitHub Actions OIDC. The workflow must grant `id-token: write`,
and the matching repository/ref must be registered in Naru before deployment.

## Usage

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

If published from a multi-action repository, use:

```yaml
- uses: naru-pub/actions/deploy@v1
  with:
    site: my-naru-login
    dir: dist
```

## Inputs

- `site`: Naru login name.
- `dir`: static site output directory.
- `target`: target prefix inside the Naru site. Defaults to `/`.
- `endpoint`: Naru control-plane endpoint. Defaults to `https://naru.pub`.
- `audience`: GitHub OIDC audience. Defaults to the endpoint origin.
- `finalize`: publish after upload. Defaults to `true`.
- `template-owner` / `template`: publish `dir` as a board template's next
  version instead (see below).
- `preview`: with a template, an image to show for it instead of a
  screenshot (see below).

## Outputs

- `deployment-id`
- `deployed-files`
- `deleted-files`
- `directory-size`

## Publishing a template

A board template whose versions come from GitHub Actions names its repository,
branch and folder on its post. Its workflow publishes that folder with
`template-owner`, the Naru account that posted the template, instead of
`site`: each run publishes `dir` as the template's next version, with the
commit message as its changelog, and the sites that installed it are told (or
updated, if they chose automatic updates).

```yaml
- uses: naru-pub/naru/actions/deploy@main
  with:
    dir: dist
    template-owner: my-naru-login
```

The workflow can come first: until a post names this repository, branch and
`dir`, a run does nothing and succeeds. Only files that changed since the
previous version are uploaded, and a run with exactly the latest version's
files makes no new version. So one repository can keep several templates,
one folder each, and publish them all on every push:

```yaml
- uses: naru-pub/naru/actions/deploy@main
  with:
    dir: templates/guestbook
    template-owner: my-naru-login
- uses: naru-pub/naru/actions/deploy@main
  with:
    dir: templates/link-tree
    template-owner: my-naru-login
```

`template: <id>` (the ID on the template's edit page) publishes to one
template by ID instead.

A template that shows nothing from its files alone (an app that needs its
site's data or a sign-in) can name a `preview` image, which the board and its
post show instead of a screenshot. PNG, JPEG or WebP up to 5 MB, shown at 4:3
from the top (1280×960 fits); it is uploaded only when it changes, and can
live outside `dir`:

```yaml
- uses: naru-pub/naru/actions/deploy@main
  with:
    dir: dist
    template-owner: my-naru-login
    preview: docs/preview.png
```
