import { execCommand, type PluginHandlerContext } from "@getpaseo/plugin/server";
import { paseoHome, projectIcon } from "./project-icons";
import {
  branchName,
  defaultAgent,
  issueMatcher,
  PAGE_SIZE,
  parseGitHubRemote,
  pullRequestsRpc,
  renderPrompt,
  type CreateAction,
  type Issue,
  type Preferences,
  type PullRequest,
} from "../shared/issues";

type PaseoApi = PluginHandlerContext["paseo"];

const run = (cmd: string, args: string[], cwd?: string) =>
  execCommand(cmd, args, { timeout: 60_000, cwd });

function errorText(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim().split("\n")[0];
  return error instanceof Error ? error.message : String(error);
}

// The desktop-managed daemon does not inherit a login shell's PATH, so Homebrew's
// bin directory is usually missing from it.
let ghPath: Promise<string> | undefined;
function findGh() {
  ghPath ??= (async () => {
    for (const p of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh", "gh"]) {
      try {
        await run(p, ["--version"]);
        return p;
      } catch {}
    }
    throw new Error("GitHub CLI (gh) is not installed on this host. Install it, then run `gh auth login`.");
  })().catch((error) => {
    ghPath = undefined;
    throw error;
  });
  return ghPath;
}

async function gh(args: string[]) {
  return run(await findGh(), args);
}

const SIGNED_OUT = /gh auth login|not logged in|authentication required/i;

type Project = { id: string; name: string; root: string; kind: string; customIconRevision: string | null };

async function listProjects(paseo: PaseoApi): Promise<Project[]> {
  const { projects } = await paseo.projects.list();
  return projects.map((p) => ({
    id: p.projectId,
    name: p.projectCustomName || p.projectDisplayName,
    root: p.projectRootPath,
    kind: p.projectKind,
    customIconRevision: p.projectCustomIconRevision ?? null,
  }));
}

type Workspace = { id: string; name: string; branch: string; projectId: string };

async function listWorkspaces(paseo: PaseoApi): Promise<Workspace[]> {
  const out: Workspace[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.workspaces.list({ page: { limit: 200, cursor } });
    for (const w of page.entries) {
      out.push({
        id: w.id,
        name: w.title ?? w.name,
        branch: w.gitRuntime?.currentBranch ?? "",
        projectId: w.projectId,
      });
    }
    cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return out;
}

type GitHubRemote = { remote: string; repo: string };

/**
 * Picks the remote whose repository holds the issues: the one chosen with
 * `gh repo set-default`, then `upstream` (forks keep issues upstream), then `origin`.
 * Returns the reason as a string when the project has no github.com remote.
 */
async function resolveRemote(root: string): Promise<GitHubRemote | string> {
  let stdout: string;
  try {
    ({ stdout } = await run("git", ["-C", root, "config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"]));
  } catch {
    return "no git remote";
  }
  const remotes = new Map<string, { url?: string; resolved?: string }>();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^remote\.(.+)\.(url|gh-resolved) (.*)$/);
    if (!m) continue;
    const entry = remotes.get(m[1]) ?? {};
    if (m[2] === "url") entry.url = m[3];
    else entry.resolved = m[3];
    remotes.set(m[1], entry);
  }
  const github = [...remotes].flatMap(([name, r]) => {
    // gh stores "base", or the chosen owner/repo when it differs from the URL.
    const repo = r.resolved?.includes("/") ? r.resolved : r.url ? parseGitHubRemote(r.url) : null;
    return repo ? [{ name, repo, isDefault: Boolean(r.resolved) }] : [];
  });
  const pick =
    github.find((r) => r.isDefault) ??
    github.find((r) => r.name === "upstream") ??
    github.find((r) => r.name === "origin") ??
    github[0];
  if (!pick) return remotes.size ? "remote is not on github.com" : "no git remote";
  return { remote: pick.name, repo: pick.repo };
}

async function localBranches(root: string): Promise<string[]> {
  const { stdout } = await run("git", ["-C", root, "branch", "--format=%(refname:short)"]);
  return stdout.split("\n").filter(Boolean);
}

async function isLinkedWorktree(root: string): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
    const [gitDir, commonDir] = stdout.trim().split("\n");
    return gitDir !== commonDir;
  } catch {
    return false;
  }
}

type RepoProjects = {
  repo: string;
  /** Where new workspaces are created: a main checkout rather than a linked worktree. */
  primary: Project;
  remote: string;
  /** Every project on this repository. Their workspaces all count as coverage. */
  projectIds: Set<string>;
  roots: string[];
  otherProjects: string[];
};

/** GitHub repositories behind the host's git projects. Several projects can share one repository. */
async function githubRepos(projects: Project[]) {
  const resolved = await Promise.all(
    projects
      .filter((p) => p.kind === "git")
      .map(async (p) => ({ project: p, remote: await resolveRemote(p.root), linked: await isLinkedWorktree(p.root) })),
  );
  const skipped: { projectName: string; reason: string }[] = [];
  const candidates = new Map<string, typeof resolved>();
  for (const entry of resolved) {
    if (typeof entry.remote === "string") {
      skipped.push({ projectName: entry.project.name, reason: entry.remote });
      continue;
    }
    const key = entry.remote.repo.toLowerCase();
    candidates.set(key, [...(candidates.get(key) ?? []), entry]);
  }
  const repos = new Map<string, RepoProjects>();
  for (const [key, entries] of candidates) {
    entries.sort((a, b) => Number(a.linked) - Number(b.linked) || a.project.name.localeCompare(b.project.name));
    const first = entries[0];
    const remote = first.remote as GitHubRemote;
    repos.set(key, {
      repo: remote.repo,
      primary: first.project,
      remote: remote.remote,
      projectIds: new Set(entries.map((e) => e.project.id)),
      roots: entries.map((e) => e.project.root),
      otherProjects: entries.slice(1).map((e) => e.project.name),
    });
  }
  return { repos, skipped };
}

/** Local branches across every checkout of a repository. Worktrees share theirs. */
async function repoBranches(roots: string[]): Promise<string[]> {
  const lists = await Promise.all(roots.map((root) => localBranches(root).catch(() => [])));
  return [...new Set(lists.flat())];
}

function coverage(n: number, branchPrefix: string, workspaces: Workspace[], branches: string[]) {
  const match = issueMatcher(n, branchPrefix);
  const ws = workspaces.find((w) => match.title(w.name) || match.branch(w.branch));
  return {
    workspace: ws ? { id: ws.id, name: ws.name } : null,
    orphanBranch: ws ? null : (branches.find(match.branch) ?? null),
  };
}

/** One result from GitHub's issue search API. */
type SearchItem = {
  number: number;
  title: string;
  html_url: string;
  labels: { name: string; color: string }[];
  user: { login: string } | null;
  created_at: string;
};

/**
 * One page of open issues in `repo` matching `query`, newest first, the way github.com lists
 * them. Uses the search API, which allows 30 searches a minute and 1,000 results per search.
 */
async function searchPage(repo: string, query: string, page: number) {
  const { stdout } = await gh([
    "api", "--method", "GET", "search/issues",
    "-f", `q=repo:${repo} is:issue state:open ${query}`.trim(),
    "-f", "sort=created", "-f", "order=desc",
    "-F", `per_page=${PAGE_SIZE}`, "-F", `page=${page}`,
  ]);
  const result = JSON.parse(stdout) as { total_count: number; items: SearchItem[] };
  return { totalCount: result.total_count, items: result.items };
}

/** What coverage needs to know about one repository: its workspaces and local branches. */
async function coverageContext(paseo: PaseoApi, r: RepoProjects, workspaces?: Workspace[]) {
  const [all, branches] = await Promise.all([workspaces ?? listWorkspaces(paseo), repoBranches(r.roots)]);
  return { workspaces: all.filter((w) => r.projectIds.has(w.projectId)), branches };
}

function toIssues(items: SearchItem[], branchPrefix: string, context: { workspaces: Workspace[]; branches: string[] }) {
  return items.map(
    (i): Issue => ({
      number: i.number,
      title: i.title,
      url: i.html_url,
      labels: i.labels.map((l) => ({ name: l.name, color: l.color })),
      // GitHub shows apps without their "[bot]" suffix.
      author: i.user?.login.replace(/\[bot\]$/, "") ?? null,
      createdAt: i.created_at,
      ...coverage(i.number, branchPrefix, context.workspaces, context.branches),
    }),
  );
}

const normalizeQuery = (query: string) => query.replace(/\s+/g, " ").trim();

/** This host's GitHub projects, one per repository, for the project picker. */
export async function projectList(paseo: PaseoApi) {
  const { repos, skipped } = await githubRepos(await listProjects(paseo));
  const home = paseoHome();
  const choices = await Promise.all(
    [...repos.values()].map(async (r) => ({
      projectId: r.primary.id,
      projectName: r.primary.name,
      repo: r.repo,
      otherProjects: r.otherProjects,
      icon: await projectIcon(home, {
        projectId: r.primary.id,
        root: r.primary.root,
        customIconRevision: r.primary.customIconRevision,
      }),
    })),
  );
  choices.sort((a, b) => a.projectName.localeCompare(b.projectName));
  return { repos: choices, skipped };
}

/** No local checkout: coverage for these issues is worked out from the other host's workspaces. */
const NO_COVERAGE = { workspaces: [] as Workspace[], branches: [] as string[] };

/** Batch the visible issues, then follow any remaining PR connection pages. */
export async function pullRequests(input: { repo: string; numbers: number[] }) {
  const { repo, numbers } = pullRequestsRpc.input.parse(input);
  const result: Record<string, PullRequest[]> = {};
  let pending = [...new Set(numbers)].map((number) => ({ number, after: null as string | null }));
  const [owner, name] = repo.split("/");
  while (pending.length) {
    const fields = pending.map(({ number, after }) => `i${number}: issue(number: ${number}) {
      closedByPullRequestsReferences(first: 100, includeClosedPrs: true, after: ${JSON.stringify(after)}) {
        nodes { number title url state isDraft reviewDecision mergeable mergeStateStatus }
        pageInfo { hasNextPage endCursor }
      }
    }`);
    let stdout: string;
    try {
      ({ stdout } = await gh([
        "api", "graphql", "-f",
        `query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields.join(" ")}}}`,
        "-f", `owner=${owner}`, "-f", `name=${name}`,
      ]));
    } catch (error) {
      throw new Error(errorText(error));
    }
    type Connection = {
      nodes: (PullRequest | null)[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
    const response = JSON.parse(stdout) as {
      data?: { repository: Record<string, { closedByPullRequestsReferences: Connection | null } | null> | null };
      errors?: { message: string }[];
    };
    // Partial GraphQL failures must not masquerade as issues with no linked PRs.
    if (response.errors?.length) throw new Error(response.errors.map((e) => e.message).join("; "));
    if (!response.data?.repository) throw new Error(`Could not load pull requests for ${repo}`);
    const next: typeof pending = [];
    for (const { number, after } of pending) {
      const connection = response.data.repository[`i${number}`]?.closedByPullRequestsReferences;
      if (!connection) throw new Error(`Could not load pull requests for ${repo}#${number}`);
      const prs = result[number] ??= [];
      for (const pr of connection.nodes) {
        if (pr && !prs.some((existing) => existing.url === pr.url)) prs.push(pr);
      }
      if (connection.pageInfo.hasNextPage) {
        const cursor = connection.pageInfo.endCursor;
        if (!cursor || cursor === after) throw new Error("Could not load the next page of pull requests");
        next.push({ number, after: cursor });
      }
    }
    pending = next;
  }
  // Active PRs first; preserve GitHub's ordering within each state.
  const rank = { OPEN: 0, MERGED: 1, CLOSED: 2 };
  for (const prs of Object.values(result)) prs.sort((a, b) => rank[a.state] - rank[b.state]);
  return { pullRequests: result };
}

/**
 * A later page of one repository's results, for the pager. `projectId` names one of this
 * host's projects; `repo` a repository that only another host has.
 */
export async function issuesPage(
  paseo: PaseoApi,
  prefs: Preferences,
  { projectId, repo, query, page }: { projectId?: string; repo?: string; query: string; page: number },
) {
  await findGh();
  const search = (slug: string) =>
    searchPage(slug, normalizeQuery(query), page).catch((error: unknown) => {
      const text = errorText(error);
      throw new Error(SIGNED_OUT.test(text) ? "GitHub CLI is not signed in on this host. Run `gh auth login`." : text);
    });
  if (repo) {
    const result = await search(repo);
    return { issues: toIssues(result.items, prefs.branchPrefix, NO_COVERAGE), totalCount: result.totalCount };
  }
  const { repos } = await githubRepos(await listProjects(paseo));
  const r = [...repos.values()].find((candidate) => candidate.projectIds.has(projectId ?? ""));
  if (!r) throw new Error("That project is no longer in Paseo, or no longer has a github.com remote");
  const [result, context] = await Promise.all([search(r.repo), coverageContext(paseo, r)]);
  return { issues: toIssues(result.items, prefs.branchPrefix, context), totalCount: result.totalCount };
}

/** Title, state, link and default branch for creating a workspace for issue `number` on another host. */
export async function issueDetails({ repo, number: n }: { repo: string; number: number }) {
  const [issue, info] = await Promise.all([
    gh(["issue", "view", String(n), "--repo", repo, "--json", "title,state,url"]),
    gh(["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]),
  ]).catch((error: unknown) => {
    throw new Error(errorText(error));
  });
  const { title, state, url } = JSON.parse(issue.stdout) as { title: string; state: string; url: string };
  const defaultBranch = info.stdout.trim();
  if (!defaultBranch) throw new Error(`${repo} has no default branch`);
  return { title, state, url, defaultBranch };
}

async function settle<T>(promise: Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await promise, error: null };
  } catch (error) {
    return { value: null, error: errorText(error) };
  }
}

/** The configured `provider/model`, else the first ready provider with its default model. */
async function resolveAgent(paseo: PaseoApi, configured: string): Promise<string> {
  if (configured) return configured;
  const agent = defaultAgent((await paseo.providers.snapshot()).entries);
  if (!agent) throw new Error("No agent provider is ready on this host. Choose one in the plugin's settings.");
  return agent;
}

// A double press must not create two worktrees for one issue.
const inFlight = new Set<string>();

export async function createWorkspace(
  paseo: PaseoApi,
  prefs: Preferences,
  { projectId, number: n, action }: { projectId: string; number: number; action: CreateAction },
) {
  const key = `${projectId}#${n}`;
  if (inFlight.has(key)) throw new Error(`#${n} is already being created`);
  inFlight.add(key);
  try {
    const { repos } = await githubRepos(await listProjects(paseo));
    const target = [...repos.values()].find((r) => r.projectIds.has(projectId));
    if (!target) throw new Error("That project is no longer in Paseo, or no longer has a github.com remote");
    const project = target.primary;

    const [issue, repo] = await Promise.all([
      gh(["issue", "view", String(n), "--repo", target.repo, "--json", "title,state,url"]),
      gh(["repo", "view", target.repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]),
    ]);
    const { title, state, url } = JSON.parse(issue.stdout) as { title: string; state: string; url: string };
    if (state !== "OPEN") throw new Error(`#${n} is ${state.toLowerCase()}`);
    const defaultBranch = repo.stdout.trim();
    if (!defaultBranch) throw new Error(`${target.repo} has no default branch`);

    const own = (await listWorkspaces(paseo)).filter((w) => target.projectIds.has(w.projectId));
    const existing = coverage(n, prefs.branchPrefix, own, await repoBranches(target.roots));
    if (existing.workspace) throw new Error(`#${n} already has workspace “${existing.workspace.name}”`);
    if (existing.orphanBranch) throw new Error(`#${n} already has local branch ${existing.orphanBranch}`);

    // Resolved before anything is created, so a missing provider leaves no workspace behind.
    const agent = action === "agent" ? await resolveAgent(paseo, prefs.agent) : null;
    const prompt =
      action === "agent" ? renderPrompt(prefs.agentPrompt, { number: String(n), title, url, repo: target.repo }) : null;

    await run("git", ["-C", project.root, "fetch", target.remote, defaultBranch, "--quiet"]);
    const branch = branchName(prefs.branchPrefix, n, title);
    const workspace = await paseo.workspaces.create({
      title: `#${n} ${title}`,
      // Tells the daemon an agent is coming, so the workspace shows as running right away.
      ...(prompt ? { firstAgentContext: { prompt, attachments: [] } } : {}),
      source: {
        kind: "worktree",
        cwd: project.root,
        action: "branch-off",
        branchName: branch,
        baseBranch: `${target.remote}/${defaultBranch}`,
      },
    });
    console.log(`created workspace ${workspace.id} for ${target.repo}#${n} on ${branch}`);
    if (!agent || !prompt) return { workspaceId: workspace.id, branch, agentId: null, agent: null };

    // The agent runs in the new worktree; the prompt is its first message.
    const started = await workspace.agents.create({ config: { provider: agent }, prompt }).catch((error: unknown) => {
      throw new Error(`Workspace “#${n} ${title}” was created, but the agent (${agent}) could not start: ${errorText(error)}`);
    });
    console.log(`started agent ${started.id} (${agent}) for ${target.repo}#${n}`);
    return { workspaceId: workspace.id, branch, agentId: started.id, agent };
  } finally {
    inFlight.delete(key);
  }
}

/** Parses `gh api --paginate --jq` output: one JSON value per line. */
const jsonLines = <T>(stdout: string): T[] =>
  stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);

type Named = { name: string; color: string; description: string | null };

/** Labels, milestones, people and issue types for the filter menus. A part that fails is left empty. */
export async function filterOptions({ repo }: { repo: string }) {
  await findGh();
  const [owner, name] = repo.split("/");
  const [me, labels, milestones, users, types] = await Promise.all([
    settle(gh(["api", "user", "--jq", ".login"]).then((r) => r.stdout.trim() || null)),
    settle(
      gh(["label", "list", "--repo", repo, "--limit", "1000", "--json", "name,color,description"]).then(
        (r) => JSON.parse(r.stdout) as Named[],
      ),
    ),
    settle(
      gh([
        "api", `repos/${repo}/milestones?state=open&per_page=100`, "--paginate",
        "--jq", ".[] | {title, description}",
      ]).then((r) => jsonLines<{ title: string; description: string | null }>(r.stdout)),
    ),
    settle(
      gh([
        "api", `repos/${repo}/assignees?per_page=100`, "--paginate",
        "--jq", ".[] | {login, avatarUrl: .avatar_url}",
      ]).then((r) => jsonLines<{ login: string; avatarUrl: string | null }>(r.stdout)),
    ),
    settle(
      gh([
        "api", "graphql",
        "-f", "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issueTypes(first:50){nodes{name color description isEnabled}}}}",
        "-F", `owner=${owner}`, "-F", `name=${name}`,
        "--jq", ".data.repository.issueTypes.nodes // [] | .[] | select(.isEnabled) | {name, color, description}",
      ]).then((r) => jsonLines<Named>(r.stdout)),
    ),
  ]);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const login = me.value ?? null;
  return {
    me: login,
    labels: (labels.value ?? []).map((l) => ({ ...l, description: l.description || null })).sort(byName),
    milestones: (milestones.value ?? []).map((m) => ({ ...m, description: m.description || null })),
    // You first, as in GitHub's menus.
    users: (users.value ?? []).sort((a, b) =>
      a.login === login ? -1 : b.login === login ? 1 : a.login.localeCompare(b.login),
    ),
    types: types.value ?? [],
  };
}

/**
 * Open issues assigned to me in each repository, in one GraphQL request. GraphQL search has
 * its own budget, so these counts don't use the REST search's 30 a minute. Failure gives no counts.
 */
export async function assignedCounts({ repos }: { repos: string[] }) {
  if (!repos.length) return { counts: {} as Record<string, number> };
  const fields = repos.map((_, i) => `r${i}: search(query: $q${i}, type: ISSUE, first: 0) { issueCount }`);
  const query = `query(${repos.map((_, i) => `$q${i}: String!`).join(", ")}) { ${fields.join(" ")} }`;
  const args = ["api", "graphql", "-f", `query=${query}`];
  repos.forEach((repo, i) => args.push("-f", `q${i}=repo:${repo} is:issue is:open assignee:@me`));
  try {
    const { data } = JSON.parse((await gh(args)).stdout) as { data: Record<string, { issueCount: number } | null> };
    const counts: Record<string, number> = {};
    repos.forEach((repo, i) => {
      const count = data?.[`r${i}`]?.issueCount;
      if (typeof count === "number") counts[repo] = count;
    });
    return { counts };
  } catch (error) {
    console.error(`assigned counts failed: ${errorText(error)}`);
    return { counts: {} as Record<string, number> };
  }
}
