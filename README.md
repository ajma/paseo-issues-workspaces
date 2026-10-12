# Issues Workspaces for Paseo

A [Paseo](https://paseo.sh) plugin that shows a project's open GitHub issues, laid out like github.com, and turns any of them into a worktree workspace with one press, optionally with an agent already working on it.

![The Issues Workspaces screen: project tabs, a search box, filter menus and a list of issues with Create workspace buttons](assets/screenshot-issues.png)

## Features

- **GitHub's issue list in Paseo.** Label colors, authors, ages, and the comfortable and compact densities, 25 issues to a page.
- **GitHub's search syntax.** The search box starts at `assignee:@me`. The Author, Labels, Milestones, Assignees and Types menus edit the search text, so the box always shows what is applied.
- **One tab per project.** Each tab has the project's Paseo icon and a count of the open issues assigned to you.
- **Create workspace** creates a worktree on a new `issue/<number>-<slug>` branch from a freshly fetched default branch, titled `#<number> <title>`.
- **Create and start an agent** also starts an agent in the new workspace with a prompt you can edit. Pick it from the arrow beside the button, as on GitHub.
- **Knows what you already started.** An issue with a workspace shows **Open workspace** instead, including workspaces on other connected hosts. A leftover local branch blocks a duplicate.
- **Linked pull requests.** A dedicated column shows one PR with review and merge status, prioritizing PRs that need attention. Select the PR number to open GitHub, or the status / additional-PR count to see every linked PR in a popover (a sheet on mobile). Extra PRs do not make the issue row taller. Draft, merged, and closed PRs are identified too.
- **Works across hosts.** Projects that only another connected host has get their own tabs, and their workspaces are created on that host.

## Requirements

- Paseo 0.11.2 or later.
- The GitHub CLI (`gh`) on the daemon host, signed in with `gh auth login`.
- Your repositories added to Paseo as projects, with a github.com remote.

## Install

```bash
paseo plugin install npm:paseo-issues-workspaces
```

Or from this repository:

```bash
paseo plugin install git:ajma/paseo-issues-workspaces
```

Add `--host <url>` to install on a remote daemon. Open it from the sidebar or the Command Center (**Issues Workspaces**).

## Settings

Open the settings with the gear next to the search box, or from **Settings → Plugins**.

| Setting | Default | What it does |
| --- | --- | --- |
| Branch prefix | `issue/` | The start of new branch names. |
| Agent | Automatic | The provider and model **Create and start an agent** uses. Automatic picks the first ready provider and its default model. |
| Agent prompt | Work on the issue, with tests | The agent's first message. `{number}`, `{title}`, `{url}` and `{repo}` are filled in from the issue. |

Settings are stored on each host and shared by every client connected to it.

## How it works

- **Finding the repository.** A project's GitHub repository comes from its git remotes: the one picked with `gh repo set-default`, then `upstream`, then `origin`. A fork therefore shows the upstream repository's issues. Projects without a github.com remote are left out.
- **Detecting workspaces.** An issue counts as having a workspace when a workspace title starts with `#<number>`, or its branch starts with the branch prefix and the number.
- **GitHub access.** Issues come from GitHub's search API through `gh`, which allows 30 searches a minute and returns at most 1,000 results per search. The plugin only reads from GitHub; it never writes to it.
- **PR status.** GitHub's closing links (such as `Closes #2` in a PR description or a manual Development link) connect PRs to issues. PR status loads separately through GraphQL and refreshes every minute while the table is active, or when you press Refresh. Branch names and plain issue mentions alone do not establish a link.

> [!NOTE]
> **Create and start an agent** sends the issue's title and URL to the agent, and the default prompt has it read the issue and its comments. On a public repository anyone can write that text, so review the prompt and the agent's permissions.

See [OVERVIEW.md](OVERVIEW.md) for the full description.

## Develop

```bash
npm install
npm run typecheck
npm test
paseo plugin install "$PWD"
# after edits
paseo plugin reload issues-workspaces
paseo plugin logs issues-workspaces
```

Paseo compiles the TypeScript itself, so there is no build step. [CLAUDE.md](CLAUDE.md) describes the architecture, the runtime boundaries and the testing setup.

## License

[MIT](LICENSE)
