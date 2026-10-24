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

## Outputs

- `deployment-id`
- `deployed-files`
- `deleted-files`
- `directory-size`

## Publishing a template

A board template whose versions come from GitHub Actions (set on its edit
page) takes `template` instead of `site`: each run publishes `dir` as the
template's next version, the commit message as its changelog, and the sites
that installed it are told (or updated, if they chose automatic updates).

```yaml
- uses: naru-pub/naru/actions/deploy@main
  with:
    dir: dist
    template: 01a1f3c2-7d0e-7b55-9c2e-5a8e0f1b3d44
```

Only files that changed since the previous version are uploaded.
