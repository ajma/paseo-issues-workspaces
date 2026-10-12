import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, pullRequestsRpc, type Preferences, type PullRequest } from "../shared/issues";

// Real git runs against temporary repositories; gh, `git fetch` and the Paseo API are faked.
const execFileAsync = promisify(execFile);

type Exec = { cmd: string; args: string[] };
type GhReply = string | Error | Promise<string>;

const fake = {
  calls: [] as Exec[],
  ghInstalled: true,
  gh: (_args: string[]): GhReply => {
    throw new Error("unexpected gh call");
  },
};

vi.mock("@getpaseo/plugin/server", () => ({
  execCommand: async (cmd: string, args: string[], options?: { cwd?: string }) => {
    fake.calls.push({ cmd, args });
    if (cmd === "gh" || cmd.endsWith("/gh")) {
      if (!fake.ghInstalled) throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
      if (args[0] === "--version") return { stdout: "gh version 2.80.0\n", stderr: "" };
      const reply = await fake.gh(args);
      if (reply instanceof Error) throw reply;
      return { stdout: reply, stderr: "" };
    }
    if (cmd === "git" && args.includes("fetch")) return { stdout: "", stderr: "" };
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, { cwd: options?.cwd, encoding: "utf8" });
      return { stdout, stderr };
    } catch (error) {
      throw Object.assign(error as Error, { stderr: (error as { stderr?: string }).stderr ?? "" });
    }
  },
}));

const ghError = (stderr: string) => Object.assign(new Error("Command failed"), { stderr: `${stderr}\n` });
const ghCalls = (sub: string) => fake.calls.filter((c) => c.cmd.endsWith("gh") && c.args.join(" ").startsWith(sub));
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

// --- Temporary git repositories ---------------------------------------------------------------

let scratch: string;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "gh-issue-workspaces-")));
  // Keep the developer's own git config out of the repositories under test.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let repoCount = 0;
async function git(cwd: string, ...args: string[]) {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function gitRepo(remotes: Record<string, string> = {}, branches: string[] = []) {
  const dir = join(scratch, `repo-${++repoCount}`);
  await execFileAsync("git", ["init", "-q", "-b", "main", dir]);
  await git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  for (const [name, url] of Object.entries(remotes)) await git(dir, "remote", "add", name, url);
  for (const branch of branches) await git(dir, "branch", branch);
  return dir;
}

async function linkedWorktree(main: string, branch: string) {
  const dir = join(scratch, `worktree-${++repoCount}`);
  await git(main, "worktree", "add", "-q", dir, "-b", branch);
  return dir;
}

// --- Fake Paseo API -----------------------------------------------------------------------------

type ProjectSpec = { id: string; name: string; root: string; kind?: "git" | "non_git" | "directory" };
type WorkspaceSpec = { id: string; title: string; projectId: string; branch?: string };

function fakePaseo({
  projects,
  workspaces = [],
  providers = [],
  agentError,
}: {
  projects: ProjectSpec[];
  workspaces?: WorkspaceSpec[];
  providers?: unknown[];
  agentError?: Error;
}) {
  const created: any[] = [];
  const agents: any[] = [];
  const entries = workspaces.map((w) => ({
    id: w.id,
    title: w.title,
    name: w.title,
    projectId: w.projectId,
    gitRuntime: { currentBranch: w.branch ?? "" },
  }));
  const api = {
    projects: {
      list: async () => ({
        projects: projects.map((p) => ({
          projectId: p.id,
          projectDisplayName: p.name,
          projectRootPath: p.root,
          projectKind: p.kind ?? "git",
        })),
      }),
    },
    workspaces: {
      // Two entries per page, to exercise the cursor loop.
      list: async ({ page }: { page?: { cursor?: string } } = {}) => {
        const start = Number(page?.cursor ?? 0);
        const next = start + 2;
        return {
          entries: entries.slice(start, next),
          pageInfo: { hasMore: next < entries.length, nextCursor: next < entries.length ? String(next) : null },
        };
      },
      create: async (options: any) => {
        created.push(options);
        return {
          id: "wks_new",
          agents: {
            create: async (a: any) => {
              agents.push(a);
              if (agentError) throw agentError;
              return { id: "agt_new" };
            },
          },
        };
      },
    },
    providers: { snapshot: async () => ({ entries: providers }) },
  };
  return { api: api as any, created, agents };
}

/** An item as GitHub's issue search API returns it. */
const issue = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  html_url: `https://github.com/octo/repo/issues/${number}`,
  labels: [],
  user: { login: "octocat" },
  created_at: "2026-10-01T00:00:00Z",
  ...overrides,
});

/** The `-f`/`-F` fields of a `gh api` call, e.g. q, page, per_page. */
function searchFields(args: string[]) {
  const fields: Record<string, string> = {};
  args.forEach((arg, i) => {
    if (args[i - 1] === "-f" || args[i - 1] === "-F") {
      const at = arg.indexOf("=");
      fields[arg.slice(0, at)] = arg.slice(at + 1);
    }
  });
  return fields;
}
const searches = () => ghCalls("api --method GET search/issues").map((c) => searchFields(c.args));

/**
 * Answers GitHub's issue search from a per-repository table of every match, paging it the way
 * the API does: `total_count` for all matches, `items` for the requested page only.
 */
function issuesByRepo(table: Record<string, unknown[] | Error>) {
  return (args: string[]): GhReply => {
    if (args.join(" ").startsWith("api --method GET search/issues")) {
      const { q, page, per_page } = searchFields(args);
      const repo = /(?:^| )repo:(\S+)/.exec(q)?.[1] ?? "";
      const result = table[repo];
      if (result === undefined) throw new Error(`no fixture for ${repo}`);
      if (result instanceof Error) return result;
      const size = Number(per_page);
      const start = (Number(page) - 1) * size;
      return JSON.stringify({ total_count: result.length, items: result.slice(start, start + size) });
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
}

const prefs = (overrides: Partial<Preferences> = {}): Preferences => ({ ...DEFAULT_PREFERENCES, ...overrides });

let mod: typeof import("./issues");
beforeEach(async () => {
  fake.calls = [];
  fake.ghInstalled = true;
  fake.gh = () => {
    throw new Error("unexpected gh call");
  };
  // Fresh module state: the gh path cache and the in-flight guard.
  vi.resetModules();
  mod = await import("./issues");
});
afterEach(() => vi.restoreAllMocks());

describe("pullRequests", () => {
  const pr = (number: number, overrides: Partial<PullRequest> = {}): PullRequest => ({
    number, title: `PR ${number}`, url: `https://github.com/octo/repo/pull/${number}`,
    state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    ...overrides,
  });
  const connection = (nodes: (PullRequest | null)[], endCursor: string | null = null) => ({
    closedByPullRequestsReferences: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } },
  });

  it("batches visible issues, includes closed PRs, follows pagination, and preserves cross-repo links", async () => {
    const open = pr(10, { reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
    const merged = pr(11, { state: "MERGED", url: "https://github.com/other/project/pull/11" });
    const draft = pr(12, { isDraft: true, reviewDecision: null, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" });
    let calls = 0;
    fake.gh = (args) => {
      const fields = searchFields(args);
      expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
      expect(fields.owner).toBe("octo");
      expect(fields.name).toBe("repo");
      expect(fields.query).toContain("includeClosedPrs: true");
      if (++calls === 1) {
        expect(fields.query.match(/issue\(number:/g)).toHaveLength(2);
        return JSON.stringify({ data: { repository: { i1: connection([merged, open, null], "next"), i2: connection([]) } } });
      }
      expect(fields.query).toContain('after: "next"');
      expect(fields.query).not.toContain("i2:");
      return JSON.stringify({ data: { repository: { i1: connection([open, draft]) } } });
    };
    const result = await mod.pullRequests({ repo: "octo/repo", numbers: [1, 2, 1] });
    expect(result).toEqual({ pullRequests: { "1": [open, draft, merged], "2": [] } });
    expect(pullRequestsRpc.output.parse(result)).toEqual(result);
    expect(calls).toBe(2);
  });

  it("makes no GitHub call for an empty page", async () => {
    expect(await mod.pullRequests({ repo: "octo/repo", numbers: [] })).toEqual({ pullRequests: {} });
    expect(fake.calls).toEqual([]);
  });

  it.each([
    { errors: [{ message: "Permission denied" }], data: { repository: { i1: connection([]) } } },
    { data: { repository: null } },
    { data: { repository: { i1: null } } },
  ])("reports inaccessible or partial results instead of claiming there are no PRs: %j", async (response) => {
    fake.gh = () => JSON.stringify(response);
    await expect(mod.pullRequests({ repo: "octo/repo", numbers: [1] })).rejects.toThrow();
  });

  it("surfaces CLI errors", async () => {
    fake.gh = () => ghError("API rate limit exceeded");
    await expect(mod.pullRequests({ repo: "octo/repo", numbers: [1] })).rejects.toThrow("API rate limit exceeded");
  });

  it.each([[-1], [1.5], Array.from({ length: 26 }, (_, i) => i + 1)])("rejects invalid issue batches: %j", async (...numbers) => {
    await expect(mod.pullRequests({ repo: "octo/repo", numbers })).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });
});

// --- projectList --------------------------------------------------------------------------------

describe("projectList", () => {
  it("lists projects with a github.com remote, reports the rest as skipped, and calls no GitHub API", async () => {
    const widgets = await gitRepo({ origin: "git@github.com:octo/widgets.git" });
    const gitlab = await gitRepo({ origin: "git@gitlab.com:octo/gadgets.git" });
    const local = await gitRepo();
    const { api } = fakePaseo({
      projects: [
        { id: "p1", name: "widgets", root: widgets },
        { id: "p2", name: "gadgets", root: gitlab },
        { id: "p3", name: "scratch", root: local },
        { id: "p4", name: "notes", root: scratch, kind: "non_git" },
      ],
    });

    expect(await mod.projectList(api)).toEqual({
      repos: [{ projectId: "p1", projectName: "widgets", repo: "octo/widgets", otherProjects: [], icon: null }],
      skipped: [
        { projectName: "gadgets", reason: "remote is not on github.com" },
        { projectName: "scratch", reason: "no git remote" },
      ],
    });
    expect(fake.calls.filter((c) => c.cmd.endsWith("gh"))).toEqual([]);
  });

  it("uses upstream over origin, so a fork lists the upstream repository", async () => {
    const fork = await gitRepo({ origin: "git@github.com:me/repo.git", upstream: "https://github.com/octo/repo.git" });
    const { api } = fakePaseo({ projects: [{ id: "p1", name: "repo", root: fork }] });

    expect((await mod.projectList(api)).repos[0].repo).toBe("octo/repo");
  });

  it("prefers the remote chosen with gh repo set-default", async () => {
    const fork = await gitRepo({ origin: "git@github.com:me/repo.git", upstream: "git@github.com:octo/repo.git" });
    await git(fork, "config", "remote.origin.gh-resolved", "base");
    const { api } = fakePaseo({ projects: [{ id: "p1", name: "repo", root: fork }] });

    expect((await mod.projectList(api)).repos[0].repo).toBe("me/repo");
  });

  it("honors a gh set-default that names a different repository", async () => {
    const dir = await gitRepo({ origin: "git@github.com:me/repo.git" });
    await git(dir, "config", "remote.origin.gh-resolved", "octo/elsewhere");
    const { api } = fakePaseo({ projects: [{ id: "p1", name: "repo", root: dir }] });

    expect((await mod.projectList(api)).repos[0].repo).toBe("octo/elsewhere");
  });

  it("lists a repository once when several projects check it out, under the main checkout", async () => {
    const main = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    const worktree = await linkedWorktree(main, "ios");
    const { api } = fakePaseo({
      projects: [
        // Listed first and alphabetically first, but a linked worktree.
        { id: "wt", name: "a-ios", root: worktree },
        { id: "main", name: "repo", root: main },
      ],
    });

    expect((await mod.projectList(api)).repos).toEqual([
      { projectId: "main", projectName: "repo", repo: "octo/repo", otherProjects: ["a-ios"], icon: null },
    ]);
  });

  it("sorts projects by name", async () => {
    const b = await gitRepo({ origin: "git@github.com:octo/b.git" });
    const a = await gitRepo({ origin: "git@github.com:octo/a.git" });
    const { api } = fakePaseo({
      projects: [
        { id: "b", name: "beta", root: b },
        { id: "a", name: "alpha", root: a },
      ],
    });

    expect((await mod.projectList(api)).repos.map((r) => r.projectName)).toEqual(["alpha", "beta"]);
  });
});

// --- issuesPage ---------------------------------------------------------------------------------

describe("issuesPage: searching", () => {
  async function oneProject(table: Record<string, unknown[] | Error> = { "octo/repo": [] }) {
    const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    fake.gh = issuesByRepo(table);
    return fakePaseo({ projects: [{ id: "p1", name: "repo", root: dir }] });
  }

  it("asks GitHub for one page of open issues, newest first, collapsing whitespace", async () => {
    const { api } = await oneProject();

    await mod.issuesPage(api, prefs(), { projectId: "p1", query: "  assignee:@me \n label:bug ", page: 1 });

    expect(searches()).toEqual([
      {
        q: "repo:octo/repo is:issue state:open assignee:@me label:bug",
        sort: "created",
        order: "desc",
        per_page: "25",
        page: "1",
      },
    ]);
  });

  it("searches every open issue for an empty query", async () => {
    const { api } = await oneProject();

    await mod.issuesPage(api, prefs(), { projectId: "p1", query: "   ", page: 1 });

    expect(searches()[0].q).toBe("repo:octo/repo is:issue state:open");
  });

  it("returns just the requested page, with the total of every match", async () => {
    const { api } = await oneProject({ "octo/repo": Array.from({ length: 60 }, (_, i) => issue(60 - i)) });

    const first = await mod.issuesPage(api, prefs(), { projectId: "p1", query: "", page: 1 });
    const third = await mod.issuesPage(api, prefs(), { projectId: "p1", query: "", page: 3 });

    expect(first.totalCount).toBe(60);
    expect(first.issues.map((i) => i.number)).toEqual(Array.from({ length: 25 }, (_, i) => 60 - i));
    expect(third.issues.map((i) => i.number)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("keeps GitHub's order and shapes labels and authors for display", async () => {
    const { api } = await oneProject({
      "octo/repo": [
        issue(10, { user: { login: "github-actions[bot]" } }),
        issue(3, { labels: [{ name: "bug", color: "d73a4a", description: "x", id: 1 }] }),
        issue(7, { user: null }),
      ],
    });

    const { issues } = await mod.issuesPage(api, prefs(), { projectId: "p1", query: "", page: 1 });

    expect(issues.map((i) => i.number)).toEqual([10, 3, 7]);
    expect(issues[0]).toMatchObject({
      author: "github-actions",
      url: "https://github.com/octo/repo/issues/10",
      createdAt: "2026-10-01T00:00:00Z",
    });
    expect(issues[1].labels).toEqual([{ name: "bug", color: "d73a4a" }]);
    expect(issues[2].author).toBeNull();
  });

  it("accepts any project on the repository, such as a linked worktree", async () => {
    const main = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    const worktree = await linkedWorktree(main, "ios");
    fake.gh = issuesByRepo({ "octo/repo": [issue(1)] });
    const { api } = fakePaseo({
      projects: [
        { id: "main", name: "repo", root: main },
        { id: "wt", name: "repo-ios", root: worktree },
      ],
    });

    expect((await mod.issuesPage(api, prefs(), { projectId: "wt", query: "", page: 1 })).issues).toHaveLength(1);
  });
});

describe("issuesPage: coverage", () => {
  it("links an issue to a workspace by title, by branch, or to a leftover local branch", async () => {
    const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" }, ["issue/3-left-behind", "issue/30-other"]);
    fake.gh = issuesByRepo({ "octo/repo": [issue(1), issue(2), issue(3), issue(4)] });
    const { api } = fakePaseo({
      projects: [{ id: "p1", name: "repo", root: dir }],
      workspaces: [
        { id: "w1", title: "#1 Issue 1", projectId: "p1" },
        { id: "w2", title: "Renamed by hand", projectId: "p1", branch: "fix/2-thing" },
        { id: "w9", title: "Unrelated", projectId: "p1", branch: "main" },
      ],
    });

    const { issues } = await mod.issuesPage(api, prefs(), { projectId: "p1", query: "", page: 1 });
    const byNumber = Object.fromEntries(issues.map((i) => [i.number, i]));

    expect(byNumber[1].workspace).toEqual({ id: "w1", name: "#1 Issue 1" });
    expect(byNumber[2].workspace).toEqual({ id: "w2", name: "Renamed by hand" });
    expect(byNumber[3]).toMatchObject({ workspace: null, orphanBranch: "issue/3-left-behind" });
    expect(byNumber[4]).toMatchObject({ workspace: null, orphanBranch: null });
  });

  it("counts workspaces from every project on the repository, but not from other repositories", async () => {
    const main = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    const worktree = await linkedWorktree(main, "ios");
    const other = await gitRepo({ origin: "git@github.com:octo/other.git" });
    fake.gh = issuesByRepo({ "octo/repo": [issue(5), issue(6)] });
    const { api } = fakePaseo({
      projects: [
        { id: "main", name: "repo", root: main },
        { id: "wt", name: "repo-ios", root: worktree },
        { id: "other", name: "other", root: other },
      ],
      workspaces: [
        { id: "w5", title: "#5 In the worktree project", projectId: "wt" },
        { id: "w6", title: "#6 Same number, other repository", projectId: "other" },
      ],
    });

    const { issues } = await mod.issuesPage(api, prefs(), { projectId: "main", query: "", page: 1 });

    expect(issues.find((i) => i.number === 5)?.workspace?.id).toBe("w5");
    expect(issues.find((i) => i.number === 6)?.workspace).toBeNull();
  });

  it("recognizes branches named with a custom prefix", async () => {
    const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" }, ["ajma-8-custom"]);
    fake.gh = issuesByRepo({ "octo/repo": [issue(8)] });
    const { api } = fakePaseo({ projects: [{ id: "p1", name: "repo", root: dir }] });

    const { issues } = await mod.issuesPage(api, prefs({ branchPrefix: "ajma-" }), {
      projectId: "p1",
      query: "",
      page: 1,
    });

    expect(issues[0].orphanBranch).toBe("ajma-8-custom");
  });
});

describe("issuesPage: failures", () => {
  it("passes on GitHub's error", async () => {
    const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    fake.gh = issuesByRepo({ "octo/repo": ghError("API rate limit exceeded for user") });
    const { api } = fakePaseo({ projects: [{ id: "p1", name: "repo", root: dir }] });

    await expect(mod.issuesPage(api, prefs(), { projectId: "p1", query: "", page: 2 })).rejects.toThrow(
      "API rate limit exceeded for user",
    );
  });

  it("explains how to sign in when gh is signed out", async () => {
    const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    fake.gh = issuesByRepo({ "octo/repo": ghError("To get started with GitHub CLI, please run:  gh auth login") });
    const { api } = fakePaseo({ projects: [{ id: "p1", name: "repo", root: dir }] });

    await expect(mod.issuesPage(api, prefs(), { projectId: "p1", query: "", page: 1 })).rejects.toThrow(
      "not signed in on this host. Run `gh auth login`",
    );
  });

  it("says how to install gh when it is missing", async () => {
    fake.ghInstalled = false;
    const { api } = fakePaseo({ projects: [] });

    await expect(mod.issuesPage(api, prefs(), { repo: "octo/repo", query: "", page: 1 })).rejects.toThrow(
      "GitHub CLI (gh) is not installed on this host",
    );
  });

  it("looks for gh in Homebrew's directories, since the daemon may lack a login PATH", async () => {
    fake.gh = issuesByRepo({ "octo/repo": [] });
    const { api } = fakePaseo({ projects: [] });
    await mod.issuesPage(api, prefs(), { repo: "octo/repo", query: "", page: 1 });
    expect(fake.calls[0]).toEqual({ cmd: "/opt/homebrew/bin/gh", args: ["--version"] });
  });

  it("refuses a project that is gone", async () => {
    const { api } = fakePaseo({ projects: [] });
    await expect(mod.issuesPage(api, prefs(), { projectId: "nope", query: "", page: 2 })).rejects.toThrow(
      "no longer in Paseo",
    );
  });
});

// --- createWorkspace ----------------------------------------------------------------------------

/** gh replies for creating a workspace for `octo/repo#n`. */
function creationGh({
  state = "OPEN",
  title = "Crash on start",
  defaultBranch = "trunk",
}: { state?: string; title?: string; defaultBranch?: string } = {}) {
  return (args: string[]): GhReply => {
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({ title, state, url: `https://github.com/octo/repo/issues/${args[2]}` });
    }
    if (args[0] === "repo" && args[1] === "view") return `${defaultBranch}\n`;
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
}

const readyClaude = {
  provider: "claude",
  status: "ready",
  enabled: true,
  models: [
    { id: "sonnet", label: "Sonnet" },
    { id: "opus", label: "Opus", isDefault: true },
  ],
};

describe("createWorkspace", () => {
  it("creates a worktree on a prefixed branch from the freshly fetched default branch", async () => {
    const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    fake.gh = creationGh({ title: "Crash on start: when the config file is missing (really!)" });
    const { api, created, agents } = fakePaseo({ projects: [{ id: "p1", name: "repo", root: dir }] });

    const result = await mod.createWorkspace(api, prefs(), { projectId: "p1", number: 42, action: "create" });

    expect(result).toEqual({
      workspaceId: "wks_new",
      branch: "issue/42-crash-on-start-when-the-config-file-is",
      agentId: null,
      agent: null,
    });
    expect(created).toEqual([
      {
        title: "#42 Crash on start: when the config file is missing (really!)",
        source: {
          kind: "worktree",
          cwd: dir,
          action: "branch-off",
          branchName: "issue/42-crash-on-start-when-the-config-file-is",
          baseBranch: "origin/trunk",
        },
      },
    ]);
    expect(agents).toEqual([]);
    const fetch = fake.calls.find((c) => c.cmd === "git" && c.args.includes("fetch"));
    expect(fetch?.args).toEqual(["-C", dir, "fetch", "origin", "trunk", "--quiet"]);
  });

  it("creates in the main checkout when asked from a linked worktree project", async () => {
    const main = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    const worktree = await linkedWorktree(main, "ios");
    fake.gh = creationGh();
    const { api, created } = fakePaseo({
      projects: [
        { id: "wt", name: "repo-ios", root: worktree },
        { id: "main", name: "repo", root: main },
      ],
    });

    await mod.createWorkspace(api, prefs(), { projectId: "wt", number: 1, action: "create" });

    expect(created[0].source.cwd).toBe(main);
  });

  it("fetches from the remote that holds the issues", async () => {
    const fork = await gitRepo({ origin: "git@github.com:me/repo.git", upstream: "git@github.com:octo/repo.git" });
    fake.gh = creationGh({ defaultBranch: "main" });
    const { api, created } = fakePaseo({ projects: [{ id: "p1", name: "repo", root: fork }] });

    await mod.createWorkspace(api, prefs(), { projectId: "p1", number: 1, action: "create" });

    expect(created[0].source.baseBranch).toBe("upstream/main");
    expect(ghCalls("issue view")[0].args).toContain("octo/repo");
  });

  it.each([
    ["Fix it", "issue/9-fix-it"],
    ["Crash: on start!!", "issue/9-crash-on-start"],
    ["Supercalifragilisticexpialidocious-and-a-half-words", "issue/9-supercalifragilisticexpialidocious-and-a"],
    ["Averyveryveryveryveryveryveryverylongsingleword", "issue/9-averyveryveryveryveryveryveryverylongsin"],
    ["🐛🔥", "issue/9"],
  ])("names the branch for %j as %s", async (title, branch) => {
    const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    fake.gh = creationGh({ title });
    const { api } = fakePaseo({ projects: [{ id: "p1", name: "repo", root: dir }] });

    expect((await mod.createWorkspace(api, prefs(), { projectId: "p1", number: 9, action: "create" })).branch).toBe(branch);
  });

  it("uses the configured branch prefix", async () => {
    const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    fake.gh = creationGh({ title: "Fix it" });
    const { api } = fakePaseo({ projects: [{ id: "p1", name: "repo", root: dir }] });

    const result = await mod.createWorkspace(api, prefs({ branchPrefix: "ajma/" }), { projectId: "p1", number: 9, action: "create" });

    expect(result.branch).toBe("ajma/9-fix-it");
  });

  describe("refuses, creating nothing,", () => {
    async function refused(setup: { state?: string; workspaces?: WorkspaceSpec[]; branches?: string[] }, message: RegExp) {
      const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" }, setup.branches);
      fake.gh = creationGh({ state: setup.state });
      const { api, created } = fakePaseo({
        projects: [{ id: "p1", name: "repo", root: dir }],
        workspaces: (setup.workspaces ?? []).map((w) => ({ ...w, projectId: "p1" })),
      });
      await expect(mod.createWorkspace(api, prefs(), { projectId: "p1", number: 7, action: "create" })).rejects.toThrow(message);
      expect(created).toEqual([]);
      expect(fake.calls.some((c) => c.args.includes("fetch"))).toBe(false);
    }

    it("for a closed issue", () => refused({ state: "CLOSED" }, /#7 is closed/));
    it("when a workspace already covers the issue", () =>
      refused({ workspaces: [{ id: "w", title: "#7 Earlier", projectId: "p1" }] }, /already has workspace “#7 Earlier”/));
    it("when a local branch for the issue exists", () =>
      refused({ branches: ["issue/7-archived"] }, /already has local branch issue\/7-archived/));
  });

  it("refuses a project that is gone or no longer on GitHub", async () => {
    const { api } = fakePaseo({ projects: [] });
    await expect(mod.createWorkspace(api, prefs(), { projectId: "nope", number: 1, action: "create" })).rejects.toThrow(
      "no longer in Paseo",
    );
  });

  it("refuses a second press for the same issue while the first is running", async () => {
    const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reply = creationGh();
    fake.gh = (args) => gate.then(() => reply(args) as string);
    const { api, created } = fakePaseo({ projects: [{ id: "p1", name: "repo", root: dir }] });

    const first = mod.createWorkspace(api, prefs(), { projectId: "p1", number: 3, action: "create" });
    await vi.waitFor(() => expect(ghCalls("issue view")).toHaveLength(1));
    await expect(mod.createWorkspace(api, prefs(), { projectId: "p1", number: 3, action: "create" })).rejects.toThrow(
      "#3 is already being created",
    );
    release();
    await first;

    expect(created).toHaveLength(1);
    // Once finished, the guard is released and the issue can be tried again.
    await expect(mod.createWorkspace(api, prefs(), { projectId: "p1", number: 3, action: "create" })).resolves.toMatchObject({
      workspaceId: "wks_new",
    });
    expect(created).toHaveLength(2);
  });
});

describe("createWorkspace: create and start an agent", () => {
  it("starts the default model of the first ready provider with the rendered prompt", async () => {
    const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    fake.gh = creationGh({ title: "Crash on start" });
    const { api, created, agents } = fakePaseo({
      projects: [{ id: "p1", name: "repo", root: dir }],
      providers: [
        { provider: "copilot", status: "unavailable", models: [{ id: "x", label: "X" }] },
        { provider: "codex", status: "ready", enabled: false, models: [{ id: "y", label: "Y" }] },
        readyClaude,
      ],
    });

    const result = await mod.createWorkspace(api, prefs({ agentPrompt: "Fix {repo}#{number}: {title} ({url})" }), {
      projectId: "p1",
      number: 42,
      action: "agent",
    });

    const prompt = "Fix octo/repo#42: Crash on start (https://github.com/octo/repo/issues/42)";
    expect(result).toMatchObject({ agentId: "agt_new", agent: "claude/opus" });
    expect(created[0].firstAgentContext).toEqual({ prompt, attachments: [] });
    expect(agents).toEqual([{ config: { provider: "claude/opus" }, prompt }]);
  });

  it("uses the agent chosen in settings as-is", async () => {
    const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    fake.gh = creationGh();
    const { api, agents } = fakePaseo({ projects: [{ id: "p1", name: "repo", root: dir }], providers: [readyClaude] });

    await mod.createWorkspace(api, prefs({ agent: "codex/gpt-5.5" }), { projectId: "p1", number: 1, action: "agent" });

    expect(agents[0].config).toEqual({ provider: "codex/gpt-5.5" });
  });

  it("falls back to the first selectable model when none is marked default", async () => {
    const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    fake.gh = creationGh();
    const { api, agents } = fakePaseo({
      projects: [{ id: "p1", name: "repo", root: dir }],
      providers: [
        {
          provider: "pi",
          status: "ready",
          models: [
            { id: "hidden", label: "Hidden", isSelectable: false },
            { id: "first", label: "First" },
          ],
        },
      ],
    });

    await mod.createWorkspace(api, prefs(), { projectId: "p1", number: 1, action: "agent" });

    expect(agents[0].config.provider).toBe("pi/first");
  });

  it("creates nothing when no provider is ready", async () => {
    const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    fake.gh = creationGh();
    const { api, created } = fakePaseo({
      projects: [{ id: "p1", name: "repo", root: dir }],
      providers: [{ provider: "claude", status: "loading", models: [] }],
    });

    await expect(mod.createWorkspace(api, prefs(), { projectId: "p1", number: 1, action: "agent" })).rejects.toThrow(
      "No agent provider is ready",
    );
    expect(created).toEqual([]);
    expect(fake.calls.some((c) => c.args.includes("fetch"))).toBe(false);
  });

  it("says the workspace exists when the agent fails to start", async () => {
    const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    fake.gh = creationGh({ title: "Crash" });
    const { api, created } = fakePaseo({
      projects: [{ id: "p1", name: "repo", root: dir }],
      providers: [readyClaude],
      agentError: new Error("model not found"),
    });

    await expect(mod.createWorkspace(api, prefs(), { projectId: "p1", number: 5, action: "agent" })).rejects.toThrow(
      "Workspace “#5 Crash” was created, but the agent (claude/opus) could not start: model not found",
    );
    expect(created).toHaveLength(1);
  });

  it("starts no agent for a plain create", async () => {
    const dir = await gitRepo({ origin: "git@github.com:octo/repo.git" });
    fake.gh = creationGh();
    const { api, created, agents } = fakePaseo({ projects: [{ id: "p1", name: "repo", root: dir }], providers: [readyClaude] });

    await mod.createWorkspace(api, prefs(), { projectId: "p1", number: 1, action: "create" });

    expect(created[0]).not.toHaveProperty("firstAgentContext");
    expect(agents).toEqual([]);
  });
});

// --- Repositories only other hosts have ---------------------------------------------------------

describe("issuesPage for another host's repository", () => {
  it("fetches the page by repository, leaving coverage to the client", async () => {
    fake.gh = issuesByRepo({ "octo/app": Array.from({ length: 30 }, (_, i) => issue(30 - i)) });
    const { api } = fakePaseo({ projects: [] });

    const result = await mod.issuesPage(api, prefs(), { repo: "octo/app", query: "", page: 2 });

    expect(searches()).toEqual([expect.objectContaining({ q: "repo:octo/app is:issue state:open", page: "2" })]);
    expect(result).toMatchObject({ totalCount: 30 });
    expect(result.issues.map((i) => i.number)).toEqual([5, 4, 3, 2, 1]);
    expect(result.issues[0].workspace).toBeNull();
  });
});

describe("issueDetails", () => {
  it("returns what creating on another host needs", async () => {
    fake.gh = creationGh({ title: "Crash", defaultBranch: "develop" });

    expect(await mod.issueDetails({ repo: "octo/repo", number: 4 })).toEqual({
      title: "Crash",
      state: "OPEN",
      url: "https://github.com/octo/repo/issues/4",
      defaultBranch: "develop",
    });
    expect(ghCalls("issue view")[0].args).toEqual(["issue", "view", "4", "--repo", "octo/repo", "--json", "title,state,url"]);
  });

  it("passes on GitHub's error", async () => {
    fake.gh = () => ghError("GraphQL: Could not resolve to an issue or pull request with the number of 999.");
    await expect(mod.issueDetails({ repo: "octo/repo", number: 999 })).rejects.toThrow("Could not resolve to an issue");
  });
});

describe("filterOptions", () => {
  function optionsGh(overrides: Record<string, GhReply> = {}) {
    return (args: string[]): GhReply => {
      const line = args.join(" ");
      const reply = Object.entries(overrides).find(([prefix]) => line.startsWith(prefix))?.[1];
      if (reply !== undefined) return reply;
      if (line === "api user --jq .login") return "ajma\n";
      if (line.startsWith("label list --repo octo/repo")) {
        return JSON.stringify([
          { name: "bug", color: "d73a4a", description: "Something isn't working" },
          { name: "android", color: "037501", description: "" },
        ]);
      }
      if (line.startsWith("api repos/octo/repo/milestones")) {
        return '{"title":"v1","description":"First"}\n{"title":"v2","description":null}\n';
      }
      if (line.startsWith("api repos/octo/repo/assignees")) {
        return [
          '{"login":"zed","avatarUrl":"z.png"}',
          '{"login":"ajma","avatarUrl":"a.png"}',
          '{"login":"amy","avatarUrl":null}',
        ].join("\n");
      }
      if (line.startsWith("api graphql")) {
        return '{"name":"Bug","color":"RED","description":"An unexpected problem"}\n{"name":"Task","color":"YELLOW","description":null}\n';
      }
      throw new Error(`unexpected gh ${line}`);
    };
  }

  it("collects labels, open milestones, assignable people and issue types", async () => {
    fake.gh = optionsGh();

    expect(await mod.filterOptions({ repo: "octo/repo" })).toEqual({
      me: "ajma",
      labels: [
        { name: "android", color: "037501", description: null },
        { name: "bug", color: "d73a4a", description: "Something isn't working" },
      ],
      milestones: [
        { title: "v1", description: "First" },
        { title: "v2", description: null },
      ],
      // You first, then alphabetical.
      users: [
        { login: "ajma", avatarUrl: "a.png" },
        { login: "amy", avatarUrl: null },
        { login: "zed", avatarUrl: "z.png" },
      ],
      types: [
        { name: "Bug", color: "RED", description: "An unexpected problem" },
        { name: "Task", color: "YELLOW", description: null },
      ],
    });
  });

  it("asks for open milestones, every page, and only enabled issue types", async () => {
    fake.gh = optionsGh();
    await mod.filterOptions({ repo: "octo/repo" });

    const milestones = ghCalls("api repos/octo/repo/milestones")[0].args;
    expect(milestones[1]).toBe("repos/octo/repo/milestones?state=open&per_page=100");
    expect(milestones).toContain("--paginate");
    const types = ghCalls("api graphql")[0].args;
    expect(types).toEqual(expect.arrayContaining(["owner=octo", "name=repo"]));
    expect(types.at(-1)).toContain("select(.isEnabled)");
  });

  it("leaves a part empty when GitHub refuses it, keeping the rest", async () => {
    fake.gh = optionsGh({
      "api graphql": ghError("Field 'issueTypes' doesn't exist"),
      "api repos/octo/repo/assignees": ghError("HTTP 403"),
    });

    const result = await mod.filterOptions({ repo: "octo/repo" });

    expect(result.types).toEqual([]);
    expect(result.users).toEqual([]);
    expect(result.labels).toHaveLength(2);
  });

  it("says how to install gh when it is missing", async () => {
    fake.ghInstalled = false;
    await expect(mod.filterOptions({ repo: "octo/repo" })).rejects.toThrow("is not installed");
  });
});

describe("assignedCounts", () => {
  it("counts each repository's open issues assigned to me in one GraphQL request", async () => {
    fake.gh = (args) => {
      expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
      return JSON.stringify({ data: { r0: { issueCount: 9 }, r1: { issueCount: 0 } } });
    };

    const result = await mod.assignedCounts({ repos: ["octo/a", "octo/b"] });

    expect(result).toEqual({ counts: { "octo/a": 9, "octo/b": 0 } });
    const [call] = ghCalls("api graphql");
    const fields = searchFields(call.args);
    // Repository names travel as variables, never spliced into the query text.
    expect(fields.q0).toBe("repo:octo/a is:issue is:open assignee:@me");
    expect(fields.q1).toBe("repo:octo/b is:issue is:open assignee:@me");
    expect(fields.query).toContain("r0: search(query: $q0, type: ISSUE, first: 0)");
    expect(fields.query).not.toContain("octo/");
  });

  it("makes no request without repositories", async () => {
    expect(await mod.assignedCounts({ repos: [] })).toEqual({ counts: {} });
    expect(ghCalls("api graphql")).toEqual([]);
  });

  it("gives no counts, rather than failing, when GitHub refuses", async () => {
    fake.gh = () => ghError("HTTP 502");
    expect(await mod.assignedCounts({ repos: ["octo/a"] })).toEqual({ counts: {} });
  });
});
