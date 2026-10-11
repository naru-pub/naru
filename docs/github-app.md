# GitHub App deploys

An owner connects a GitHub repository to their site on `/deploys`, and every
push to its branch is published: no workflow file, no repository variables.
This is the route for sites whose files are in the repository as they are
served. A site that needs a build step keeps [GitHub CI deploys](github-ci.md),
which run in the owner's own workflow.

## The App

Naru's GitHub App is `naru-pub` (github.com/apps/naru-pub), owned by the
naru-pub organization and installable on any account. It reads repository
contents and metadata and nothing else, and receives `push` events (GitHub
always sends `installation` and `installation_repositories`).

| Setting                                   | Value                                                  |
| ----------------------------------------- | ------------------------------------------------------ |
| Callback URL                              | `https://naru.pub/api/github/callback`                 |
| Request user authorization during install | on (the callback then also receives `installation_id`) |
| Redirect on update                        | on                                                     |
| Webhook URL                               | `https://naru.pub/api/github/webhook`                  |

The control plane reads `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`
(the `.pem`, base64-encoded on one line) and `GITHUB_APP_WEBHOOK_SECRET`, in
infra's `apps/naru/secrets/naru.env`. Without all six, `/deploys` shows only
the Actions card and the routes answer 404.

## Linking: who may publish what

`/api/github/install` sends the owner to install the App (choosing
repositories there); `/api/github/connect` signs them in to GitHub when it is
installed already. Both return to `/api/github/callback` with a state cookie
and the person's OAuth code. Naru uses that user token once: it lists the
App's installations the GitHub user reaches and, in each, the repositories
the user can read (`/user/installations/{id}/repositories`), records them in
`github_installations` for the Naru account, and drops the token.

That second list is the authorization boundary. An organization installs the
App once for all its repositories, so an installation alone would let any
member publish a private repository they cannot read. A Naru account may
connect, and keep deploying, only repositories its GitHub user could read when
it last linked; linking again refreshes the list.

## One deploy per site folder

A connected repository and a workflow deploy are both rows of
`github_deploy_targets`, and a workflow's plan matches only rows without an
installation, so a workflow never publishes over an App target. Beyond that,
no new target of either kind may use a site folder that is the same as, or
inside or around, the folder of another enabled target of the account
(`assertNoOverlappingTarget`): each deletes only what it published, but where
two publish the same path the last one wins, and an App deploy and a build
would take turns replacing each other's files. Saving the same target again is
not a conflict, and targets in separate folders (say the repository at
`/blog/` and a build at `/app/`) are fine. Targets that overlapped before this
rule are left as they are.

## Deploying

Connecting a repository (`POST /api/account/github-app`) creates or updates a
`github_deploy_targets` row with the installation, repository id, branch,
`source_dir` (the repository folder to publish) and `target_prefix` (where on
the site), marked with the branch's current commit. A signed `push` delivery
marks every target of that installation, repository and ref with the pushed
commit (`pending_sha`); later pushes replace the mark, so a burst deploys once.
"지금 배포" marks the branch's current commit.

Marked targets are deployed right after the request that marked them, and
every minute by the `github-app-deploys` maintenance job
(`cli/run-github-deploys.ts`), which also takes over a deploy that has held a
target (`deploying_at`) for fifteen minutes. A deploy:

1. gets an installation token limited to reading that one repository;
2. downloads the commit's archive (at most 100 MB) and keeps, from
   `source_dir`, only what a site serves: no dotfiles or dot-folders (`.git`,
   `.github`, `.env`), no `node_modules`, no links, only the file types Naru
   hosts; at most 5,000 files, 10 MB each and 100 MB in all, and an
   `index.html`. What it leaves out is recorded in the deployment's
   `skipped_paths`;
3. plans the deployment as a workflow's would (`planDeployment`): only changed
   files are uploaded, to the staging prefix, and the target's generation is
   claimed;
4. publishes it (`publishPlannedDeployment`), exactly as a workflow's finalize
   does: checks, copies, deletes what the commit no longer has, updates the
   site title and size, purges the cache.

A failure is kept as the target's `last_error`, shown on `/deploys`, and its
mark cleared; the next push or "지금 배포" tries again. A push that arrives
during a deploy keeps its mark and is deployed after it.

Removing the App, or a repository from it, disables the targets it served and
forgets the repositories (`installation` and `installation_repositories`
deliveries). Disconnecting a target on `/deploys` disables it and leaves its
files on the site.
