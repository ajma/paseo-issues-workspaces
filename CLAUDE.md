# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Issues Workspaces**, a [Paseo](https://paseo.sh) plugin (manifest id `issues-workspaces`, npm `paseo-issues-workspaces`). It shows one project's open GitHub issues laid out like github.com: project tabs, a search box, filter menus in the table header, and paging. One press creates a Paseo worktree workspace for an issue; "Create and start an agent" also starts one with a prompt. `OVERVIEW.md` is the user-facing description used by the Paseo registry. Keep it in sync with behavior, following the registry's rules: plain facts, no install commands, no em dashes.

## Commands

```bash
npm run typecheck   # three passes: client+shared (no Node types), server+shared (Node), tests
npm test            # vitest run
npx vitest run server/issues.test.ts            # one file
npx vitest run client/issues-screen -t "paging" # tests whose name matches
paseo plugin reload issues-workspaces           # load source edits into the running daemon
paseo plugin ls                                 # require status "running"
paseo plugin logs issues-workspaces             # server-side console output and crashes
```

Install a checkout with `paseo plugin install "$PWD"`; it installs as `issues-workspaces` (the manifest id). Reload after edits rather than restarting the daemon. Paseo compiles the TypeScript itself, so there is no build step.

## Runtime boundaries (enforced by Paseo's compiler)

- `index.client.tsx` + `client/`: app bundle (React Native; runs on desktop/web via react-native-web, and iOS/Android). No Node imports, no DOM.
- `index.server.ts` + `server/`: daemon subprocess (Node). Shells out to `gh` and `git` through `execCommand`.
- `shared/`: imported by both. Zod RPC contracts, the settings schema, and pure helpers only.
- No other code modules at the plugin root. Host modules (`@getpaseo/plugin*`, react, react-native, zod, @tanstack/react-query) are supplied at runtime and are devDependencies here.

## Architecture

**RPCs** (defined in `shared/issues.ts`, handled in `index.server.ts` → `server/issues.ts`):
- `issues.projects`: this host's git projects with a github.com remote, one entry per repo, each with its icon. Makes no GitHub calls.
- `issues.page`: one page (25) of a repo's open issues in the chosen sort order via the GitHub **search API** (`gh api search/issues`, 30 searches/min, 1,000-result cap). It also marks coverage. Takes `projectId` for this host's projects, or `repo` for a project only another host has.
- `issues.filter-options`: labels, milestones, assignable users, org issue types, and the signed-in login.
- `issues.assigned-counts`: open issues assigned to me per repo for the tab badges, in one GraphQL request (GraphQL budget, not the REST search limit). Fetched separately so it never blocks the page.
- `issues.create-workspace`: creates a worktree workspace on this host; with `action: "agent"` it also starts an agent with the agent prompt.
- `issues.details`: issue title/state and the repo's default branch, used when creating on another host.

**Repo resolution** (`server/issues.ts`): a project's GitHub repo comes from its git remotes, in this order: the remote marked by `gh repo set-default` (`remote.<name>.gh-resolved`), then `upstream`, then `origin`. Several Paseo projects on one repo (e.g. a checkout plus a linked worktree) collapse into one entry whose primary is the main checkout. Workspaces in any of those projects count as coverage.

**Coverage**: an issue is "covered" when a workspace title starts with `#<n>`, or its branch matches `<prefix><n>-` or `/<n>-` (`issueMatcher` in shared). A local branch with no workspace is reported as `orphanBranch`, and creation is refused.

**The search box is the single source of truth.** Filter menus only edit the query text (`client/query-filters.ts`: `label:"x"`, `no:label`, `assignee:@me`, ...). `is:issue state:open repo:<slug>` is always prepended server-side and never shown.

**Other hosts** (`client/other-hosts.ts`, `client/remote-create.ts`): the client reads other online hosts' projects and workspaces through `getPaseoClient(serverId)`. Projects only another host has become extra tabs. Their issues are searched with *this* host's `gh`, and creation goes through that host's SDK connection (no `git fetch` is possible there). Their coverage is computed client-side (`withRemoteCoverage`).

**Project icons** (`server/project-icons.ts`) re-implement Paseo 0.11.2's private icon lookup, because the plugin SDK has no icon call. The order is: the custom icon file at `<PASEO_HOME>/projects/icons/<sha256(projectId)>.bin` (only when the project has a custom icon revision), then a repository search (priority dirs → monorepo packages → root). `iconRevision()` reproduces Paseo's fingerprint, so results can be checked against `projectIconRevision` from the daemon. Because this copies private Paseo 0.11.2 logic, a later Paseo release can change it without notice; when no icon is found, the tabs fall back to the generic `BookMarked` icon (`client/project-selector.tsx`).

**Settings** (`preferences` in shared, version 1; when renaming or reshaping a stored key, bump `version` and add a `migrate` function): one host-scoped document holding the branch prefix, agent, effort (a thinking option id, passed as `thinkingOptionId` only when the model offers it), agent prompt, selected repo, saved search, sort order and density. The screen applies changes locally at once and also saves them. `effectivePreferences` repairs invalid values on both sides.

## UI gotchas

- **Stacking:** react-native-web gives every View `position: relative; z-index: 0`, so every View is its own stacking context. The open filter menu must sit above the screen's "close filter menu" layer: the table wrapper is `zIndex: 6`, the layer is 5, and a second layer inside the table covers the rows below the header. `paintsAbove()` in `client/issues-screen.test.tsx` checks this; testing-library clicks alone don't.
- **Native touches:** iOS and Android don't deliver touches outside a parent's bounds, so filter menus open as a sheet (`Modal`) whenever `layout.compact || platform !== "web"`.
- **Accessibility state:** use `aria-checked` / `aria-selected` / `aria-disabled`. react-native-web 0.21 ignores `accessibilityState`.
- **Icons:** Lucide names must exist in Paseo's Lucide 1.x set; there are no brand icons such as `Github`. The sidebar's crossed hammer-and-wrench is a tinted PNG (`client/tools-icon-data.ts`); `assets/icon.png` is the registry icon. Both are rendered from `assets/icon.svg`: the sidebar PNG at 96px in black on transparent, the registry icon in white on a 256px `#1f2328` tile with 58px corners. Paseo draws sidebar icons at only 14px on desktop, so check changes at that size.
- **Colors** come from `theme.colors`. GitHub-specific colors (label formulas, open-issue greens, issue-type colors) live in `client/github-style.ts`. Project tabs copy Paseo's workspace tab chips (`workspace-desktop-tabs-row.tsx` in getpaseo/paseo), with light/dark chosen from the luminance of `surface0`.

## Tests

- **Vitest**, with tests next to the code (`*.test.ts[x]`), excluded from the npm package.
- **CI** (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck` and `npm test` on pushes to main and on pull requests.
- **Server tests** run real `git` in temp repos (global git config disabled) and fake only `gh`, `git fetch`, and the Paseo API. The `issuesByRepo` fake emulates the search API's paging.
- **Screen tests** render the real screens with react-native-web in jsdom (`// @vitest-environment jsdom`). They alias `react-native` → `react-native-web` in `vitest.config.ts` and stand in for Paseo's host modules with `client/test-host.tsx`. Hover tests must dispatch `pointerenter`/`mouseenter` events that carry `pointerType: "mouse"`.
