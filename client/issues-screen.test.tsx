// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type Issue, type Preferences, type PullRequest, type RepoProject } from "../shared/issues";
import { host, readySettings, resetHost } from "./test-host";

vi.mock("@getpaseo/plugin/client", async () => (await import("./test-host")).clientModule);
vi.mock("@getpaseo/plugin/client/react-native", async () => (await import("./test-host")).reactNativeModule);
vi.mock("@getpaseo/plugin/client/ui", async () => (await import("./test-host")).uiModule);

const { IssuesScreen } = await import("./issues-screen");

// --- Fixtures -----------------------------------------------------------------------------------

const lightTheme = {
  colors: {
    surface0: "#ffffff",
    surface1: "#f6f8fa",
    surface2: "#eaeef2",
    border: "#d0d7de",
    foreground: "#1f2328",
    foregroundMuted: "#59636e",
    accent: "#0969da",
    accentForeground: "#ffffff",
    statusSuccess: "#1a7f37",
    statusWarning: "#9a6700",
    statusDanger: "#d1242f",
  },
};

const theme = {
  colors: {
    surface0: "#0d1117",
    surface1: "#161b22",
    surface2: "#21262d",
    border: "#30363d",
    foreground: "#e6edf3",
    foregroundMuted: "#7d8590",
    accent: "#2f81f7",
    accentForeground: "#ffffff",
    statusSuccess: "#3fb950",
    statusWarning: "#d29922",
    statusDanger: "#f85149",
  },
};

const issue = (number: number, overrides: Partial<Issue> = {}): Issue => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/octo/repo/issues/${number}`,
  labels: [],
  author: "octocat",
  createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  workspace: null,
  orphanBranch: null,
  ...overrides,
});

const project = (repo: string, overrides: Partial<RepoProject> = {}): RepoProject => ({
  projectId: `p-${repo}`,
  projectName: repo.split("/")[1],
  repo,
  otherProjects: [],
  icon: null,
  ...overrides,
});

function serveProjects(repos: RepoProject[], skipped: { projectName: string; reason: string }[] = []) {
  host.rpcs.set("issues.projects", async () => ({ repos, skipped }));
}

type PageRequest = { projectId?: string; repo?: string; query: string; page: number };

/** Fakes issues.page from every match per project id or repository, 25 to a page, recording requests. */
function servePages(table: Record<string, Issue[] | Error>) {
  const requests: PageRequest[] = [];
  host.rpcs.set("issues.page", async (input) => {
    const request = input as PageRequest;
    requests.push(request);
    const all = table[request.projectId ?? request.repo ?? ""];
    if (all === undefined) throw new Error(`no fixture for ${request.projectId ?? request.repo}`);
    if (all instanceof Error) throw all;
    return { issues: all.slice((request.page - 1) * 25, request.page * 25), totalCount: all.length };
  });
  return requests;
}

type Options = {
  me: string | null;
  labels: { name: string; color: string; description: string | null }[];
  milestones: { title: string; description: string | null }[];
  users: { login: string; avatarUrl: string | null }[];
  types: { name: string; color: string; description: string | null }[];
};
const noOptions: Options = { me: "ajma", labels: [], milestones: [], users: [], types: [] };

function serveOptions(options: Partial<Options> = {}) {
  const requests: unknown[] = [];
  host.rpcs.set("issues.filter-options", async (input) => {
    requests.push(input);
    return { ...noOptions, ...options };
  });
  return requests;
}

function serveCreate() {
  const requests: unknown[] = [];
  host.rpcs.set("issues.create-workspace", async (input) => {
    requests.push(input);
    const { action } = input as { action: string };
    return {
      workspaceId: "wks_new",
      branch: "issue/1-x",
      agentId: action === "agent" ? "agt" : null,
      agent: action === "agent" ? "claude/opus" : null,
    };
  });
  return requests;
}

/** One project, octo/repo, with the given issues. */
function oneProject(issues: Issue[] | Error) {
  serveProjects([project("octo/repo")]);
  serveOptions();
  return servePages({ "p-octo/repo": issues });
}

const navigation = { openWorkspace: vi.fn(), openAgent: vi.fn() };

function renderScreen({ compact = false, light = false, platform = "web" }: { compact?: boolean; light?: boolean; platform?: "web" | "ios" } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IssuesScreen
        theme={light ? lightTheme : theme}
        layout={{ compact, platform }}
        host={{ id: "srv_here", label: "Laptop" }}
        navigation={navigation}
        params={{}}
      />
    </QueryClientProvider>,
  );
}

const prefs = (overrides: Partial<Preferences> = {}): Preferences => ({ ...DEFAULT_PREFERENCES, ...overrides });
const settle = () => new Promise((r) => setTimeout(r, 20));
const search = (text: string) => {
  const box = screen.getByLabelText(/Search issues/);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
};

/**
 * Whether `a` paints above `b`. react-native-web gives every View position: relative and a
 * z-index, so each View is its own stacking context: compare the branches where they diverge.
 */
function paintsAbove(a: Element, b: Element) {
  const chain = (el: Element) => {
    const out: Element[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) out.unshift(e);
    return out;
  };
  const [ca, cb] = [chain(a), chain(b)];
  let i = 0;
  while (ca[i] === cb[i]) i++;
  const z = (el: Element) => Number(getComputedStyle(el).zIndex) || 0;
  if (z(ca[i]) !== z(cb[i])) return z(ca[i]) > z(cb[i]);
  return Boolean(cb[i].compareDocumentPosition(ca[i]) & Node.DOCUMENT_POSITION_FOLLOWING);
}

beforeEach(() => {
  resetHost();
  host.rpcs.set("issues.pull-requests", async () => ({ pullRequests: {} }));
  navigation.openWorkspace.mockClear();
});
afterEach(cleanup);

const pullRequest = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  number: 42,
  title: "Fix the issue",
  url: `https://github.com/octo/repo/pull/${overrides.number ?? 42}`,
  state: "OPEN",
  isDraft: false,
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  ...overrides,
});

describe("issues screen: pull requests", () => {
  it.each([false, true])("shows multiple linked PRs and opens the selected PR (compact: %s)", async (compact) => {
    readySettings(prefs({ density: compact ? "compact" : "comfortable" }));
    oneProject([issue(1), issue(2)]);
    const requests = vi.fn(async () => ({ pullRequests: {
      "1": [pullRequest(), pullRequest({ number: 43, url: "https://github.com/other/repo/pull/43", state: "MERGED" })],
      "2": [],
    } }));
    host.rpcs.set("issues.pull-requests", requests);
    renderScreen({ compact, light: compact });
    const link = await screen.findByRole("link", { name: "Open pull request 42 on GitHub: Fix the issue" });
    expect(requests).toHaveBeenCalledWith({ repo: "octo/repo", numbers: [1, 2] });
    expect(screen.getAllByText("Approved")).toHaveLength(1);
    expect(screen.getByText("Mergeable")).toBeTruthy();
    expect(screen.queryByText("Merged")).toBeNull();
    fireEvent.click(link);
    expect(host.opened).toEqual(["https://github.com/octo/repo/pull/42"]);
    fireEvent.click(screen.getByRole("button", { name: "Show all 2 pull requests for issue 1" }));
    const list = await screen.findByRole("dialog", { name: "Pull requests for issue 1" });
    expect(within(list).getByText("Merged")).toBeTruthy();
    fireEvent.click(within(list).getByRole("link", { name: "Open pull request 43 on GitHub: Fix the issue" }));
    expect(host.opened.at(-1)).toBe("https://github.com/other/repo/pull/43");
    expect(screen.getByRole("button", { name: "Create workspace for issue 1" })).toBeTruthy();
  });

  it.each([
    [{ reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BLOCKED" }, "Changes requested", "Merge blocked"],
    [{ reviewDecision: "REVIEW_REQUIRED", mergeable: "CONFLICTING" }, "Review required", "Merge conflicts"],
    [{ reviewDecision: null, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, "No review decision", "Mergeability unknown"],
    [{ isDraft: true }, "Approved", "Draft"],
    [{ state: "CLOSED" }, "Approved", "Closed"],
    [{ mergeStateStatus: "BEHIND" }, "Approved", "Branch out of date"],
    [{ mergeStateStatus: "UNSTABLE" }, "Approved", "Checks not passing"],
    [{ mergeStateStatus: "FUTURE_STATE" }, "Approved", "Mergeability unknown"],
  ] as [Partial<PullRequest>, string, string][])("renders review and merge states: %j", async (overrides, review, merge) => {
    readySettings(prefs());
    oneProject([issue(1)]);
    host.rpcs.set("issues.pull-requests", async () => ({ pullRequests: { "1": [pullRequest(overrides)] } }));
    renderScreen();
    expect(await screen.findByText(merge)).toBeTruthy();
    expect(screen.getByText(review)).toBeTruthy();
    expect(screen.queryByText("Mergeable")).toBeNull();
  });

  it("keeps issues usable during a slow PR lookup, reports failure, and retries on refresh", async () => {
    readySettings(prefs());
    oneProject([issue(1)]);
    let reject!: (error: Error) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValue({ pullRequests: { "1": [pullRequest()] } });
    host.rpcs.set("issues.pull-requests", fetch);
    renderScreen();
    expect(await screen.findByRole("button", { name: "Create workspace for issue 1" })).toBeTruthy();
    expect(await screen.findByText("Updating PR status…")).toBeTruthy();
    await act(async () => reject(new Error("GitHub unavailable")));
    expect(await screen.findByText(/Could not load PR status: GitHub unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh issues" }));
    expect(await screen.findByText("Mergeable")).toBeTruthy();
    expect(screen.queryByText(/Could not load PR status/)).toBeNull();
  });

  it("does not request PR status for an empty page", async () => {
    readySettings(prefs());
    oneProject([]);
    const fetch = vi.fn();
    host.rpcs.set("issues.pull-requests", fetch);
    renderScreen();
    await screen.findByText("No results matched your search.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches only visible issue numbers and keeps PRs scoped to their repository", async () => {
    readySettings(prefs());
    serveProjects([project("octo/a"), project("octo/b")]);
    serveOptions();
    servePages({
      "p-octo/a": Array.from({ length: 26 }, (_, i) => issue(i + 1)),
      "p-octo/b": [issue(26)],
    });
    const requests: { repo: string; numbers: number[] }[] = [];
    let resolveB!: (value: unknown) => void;
    host.rpcs.set("issues.pull-requests", async (input) => {
      const request = input as { repo: string; numbers: number[] };
      requests.push(request);
      if (request.repo === "octo/b") return new Promise((resolve) => { resolveB = resolve; });
      return { pullRequests: Object.fromEntries(request.numbers.map((n) => [n, [pullRequest({ title: `PR for a/${n}` })]])) };
    });
    renderScreen();
    await screen.findByRole("link", { name: "Open pull request 42 on GitHub: PR for a/1" });
    expect(requests[0]).toEqual({ repo: "octo/a", numbers: Array.from({ length: 25 }, (_, i) => i + 1) });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("link", { name: "Open pull request 42 on GitHub: PR for a/26" });
    expect(screen.queryByRole("link", { name: "Open pull request 42 on GitHub: PR for a/1" })).toBeNull();
    expect(requests[1]).toEqual({ repo: "octo/a", numbers: [26] });
    fireEvent.click(screen.getByRole("tab", { name: "b (octo/b)" }));
    await waitFor(() => expect(requests[2]).toEqual({ repo: "octo/b", numbers: [26] }));
    expect(screen.queryByRole("link", { name: "Open pull request 42 on GitHub: PR for a/26" })).toBeNull();
    await act(async () => resolveB({ pullRequests: { "26": [pullRequest({ title: "PR for b/26" })] } }));
    await screen.findByRole("link", { name: "Open pull request 42 on GitHub: PR for b/26" });
  });

  it("refreshes a previously loaded PR's review and merge state", async () => {
    readySettings(prefs());
    oneProject([issue(1)]);
    const fetch = vi.fn().mockResolvedValueOnce({ pullRequests: { "1": [pullRequest()] } })
      .mockResolvedValue({ pullRequests: { "1": [pullRequest({ reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BLOCKED" })] } });
    host.rpcs.set("issues.pull-requests", fetch);
    renderScreen();
    await screen.findByText("Mergeable");
    fireEvent.click(screen.getByRole("button", { name: "Refresh issues" }));
    await screen.findByText("Changes requested");
    expect(screen.getByText("Merge blocked")).toBeTruthy();
    expect(screen.queryByText("Approved")).toBeNull();
    expect(screen.queryByText("Mergeable")).toBeNull();
  });

  it.each([
    { reviewDecision: "CHANGES_REQUESTED" },
    { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
  ])("summarizes the PR needing attention, hiding extra PRs until expanded: %j", async (blocked) => {
    readySettings(prefs());
    oneProject([issue(1), issue(2)]);
    host.rpcs.set("issues.pull-requests", async () => ({ pullRequests: { "1": [
      pullRequest(),
      pullRequest({ number: 43, url: "https://github.com/octo/repo/pull/43", ...blocked }),
      pullRequest({ number: 44, state: "CLOSED", reviewDecision: "CHANGES_REQUESTED" }),
    ] } }));
    renderScreen();
    const primary = await screen.findByRole("link", { name: "Open pull request 43 on GitHub: Fix the issue" });
    expect(screen.queryByRole("link", { name: "Open pull request 42 on GitHub: Fix the issue" })).toBeNull();
    expect(screen.getByText("+2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all 3 pull requests for issue 1" }));
    const list = screen.getByRole("dialog", { name: "Pull requests for issue 1" });
    expect(within(list).getAllByRole("link")).toHaveLength(3);
    expect(getComputedStyle(list).position).toBe("absolute");
    expect(paintsAbove(list, screen.getByRole("link", { name: "Open issue 2 on GitHub: Issue 2" }))).toBe(true);
    fireEvent.click(within(list).getByRole("button", { name: "Close pull requests" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(primary);
    expect(host.opened).toEqual(["https://github.com/octo/repo/pull/43"]);
  });

  it.each([{ compact: true }, { platform: "ios" as const }])("uses a sheet on small or native layouts: %j", async (layout) => {
    readySettings(prefs());
    oneProject([issue(1)]);
    host.rpcs.set("issues.pull-requests", async () => ({ pullRequests: { "1": [pullRequest(), pullRequest({ number: 43 })] } }));
    renderScreen(layout);
    fireEvent.click(await screen.findByRole("button", { name: "Show all 2 pull requests for issue 1" }));
    const sheet = screen.getByRole("dialog", { name: "Pull requests for issue 1" });
    expect(getComputedStyle(sheet).position).not.toBe("absolute");
    expect(within(sheet).getAllByRole("link")).toHaveLength(2);
  });

  it("dismisses PR details before opening a filter or create menu", async () => {
    readySettings(prefs());
    oneProject([issue(1)]);
    host.rpcs.set("issues.pull-requests", async () => ({ pullRequests: { "1": [pullRequest(), pullRequest({ number: 43 })] } }));
    renderScreen();
    const more = await screen.findByRole("button", { name: "Show all 2 pull requests for issue 1" });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("button", { name: "More ways to create a workspace for issue 1" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(more);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Labels/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// --- Loading ------------------------------------------------------------------------------------

describe("issues screen: loading", () => {
  it("shows page 1 of issues assigned to me in the project", async () => {
    readySettings(prefs());
    const requests = oneProject([issue(1)]);
    renderScreen();

    expect(await screen.findByText("Issue 1")).toBeTruthy();
    expect(requests).toEqual([{ projectId: "p-octo/repo", query: "assignee:@me", page: 1 }]);
  });

  it("starts from the saved search", async () => {
    readySettings(prefs({ searchQuery: "label:bug" }));
    const requests = oneProject([]);
    renderScreen();

    await waitFor(() => expect(requests.map((r) => r.query)).toEqual(["label:bug"]));
  });

  it("shows why issues could not load, inside the table", async () => {
    readySettings(prefs());
    oneProject(new Error("GitHub CLI is not signed in on this host. Run `gh auth login`."));
    renderScreen();

    expect(await screen.findByText(/Could not load issues: GitHub CLI is not signed in/)).toBeTruthy();
  });

  it("says when nothing matches", async () => {
    readySettings(prefs());
    oneProject([]);
    renderScreen();

    expect(await screen.findByText("No results matched your search.")).toBeTruthy();
    expect(screen.getByText("0 Open")).toBeTruthy();
  });

  it("explains when no project is on GitHub, without listing the skipped ones", async () => {
    readySettings(prefs());
    serveProjects([], [{ projectName: "scratch", reason: "no git remote" }]);
    renderScreen();

    expect(await screen.findByText(/None of your Paseo projects has a github.com remote/)).toBeTruthy();
    expect(screen.queryByText(/Not on GitHub/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Labels/ })).toBeNull();
  });

  it("does not list projects that are not on GitHub", async () => {
    readySettings(prefs());
    serveProjects([project("octo/repo")], [{ projectName: "dotfiles", reason: "no git remote" }]);
    serveOptions();
    servePages({ "p-octo/repo": [issue(1)] });
    renderScreen();

    await screen.findByText("Issue 1");
    expect(screen.queryByText(/Not on GitHub/)).toBeNull();
    expect(screen.queryByText(/dotfiles/)).toBeNull();
  });

  it("opens the plugin's settings from a gear beside refresh", async () => {
    readySettings(prefs());
    oneProject([issue(1)]);
    const onOpenSettings = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <IssuesScreen
          theme={theme}
          layout={{ compact: false, platform: "web" }}
          host={{ id: "srv_here", label: "Laptop" }}
          navigation={navigation}
          params={{}}
          onOpenSettings={onOpenSettings}
        />
      </QueryClientProvider>,
    );

    const gear = await screen.findByRole("button", { name: "Issues Workspaces settings" });
    expect(gear.querySelector('[data-icon="Settings"]')).not.toBeNull();
    const refresh = screen.getByRole("button", { name: "Refresh issues" });
    expect(Boolean(refresh.compareDocumentPosition(gear) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    fireEvent.click(gear);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("has no gear when nothing can open settings", async () => {
    readySettings(prefs());
    oneProject([issue(1)]);
    renderScreen();

    await screen.findByText("Issue 1");
    expect(screen.queryByRole("button", { name: "Issues Workspaces settings" })).toBeNull();
  });

  it("has no title and no summary line above the list", async () => {
    readySettings(prefs());
    oneProject([issue(1), issue(2, { workspace: { id: "w", name: "#2" } })]);
    renderScreen();

    await screen.findByText("Issue 1");
    expect(screen.queryByText("Issues")).toBeNull();
    expect(screen.queryByText(/Laptop/)).toBeNull();
    expect(screen.queryByText(/open across/)).toBeNull();
    expect(screen.queryByText(/without a workspace/)).toBeNull();
  });
});

// --- Rows ---------------------------------------------------------------------------------------

describe("issues screen: rows", () => {
  it("shows the GitHub open icon, title, labels and who opened it", async () => {
    readySettings(prefs());
    oneProject([issue(7, { labels: [{ name: "bug", color: "d73a4a" }], author: "github-actions" })]);
    renderScreen();

    await screen.findByText("Issue 7");
    expect(screen.getByText("bug")).toBeTruthy();
    expect(screen.getByText("#7 opened 2 days ago by github-actions")).toBeTruthy();
    expect(screen.getByText("1 Open")).toBeTruthy();
    expect(document.querySelectorAll('[data-icon="CircleDot"]').length).toBeGreaterThanOrEqual(2);
  });

  it("lets a long title shrink and wrap instead of widening the page", async () => {
    readySettings(prefs());
    oneProject([issue(7, { title: "A very long issue title ".repeat(10) })]);
    renderScreen({ compact: true });

    const link = await screen.findByRole("link", { name: /Open issue 7 on GitHub/ });
    // React Native items default to flexShrink 0, which kept the title on one ever-wider line.
    expect(getComputedStyle(link).flexShrink).toBe("1");
  });

  it("opens the issue on GitHub from its title", async () => {
    readySettings(prefs());
    oneProject([issue(7)]);
    renderScreen();

    fireEvent.click(await screen.findByRole("link", { name: /Open issue 7 on GitHub/ }));
    expect(host.opened).toEqual(["https://github.com/octo/repo/issues/7"]);
  });

  it("offers Open workspace for a covered issue", async () => {
    readySettings(prefs());
    oneProject([issue(7, { workspace: { id: "wks_7", name: "#7 Issue 7" } })]);
    renderScreen();

    fireEvent.click(await screen.findByRole("button", { name: "Open workspace for issue 7" }));
    expect(navigation.openWorkspace).toHaveBeenCalledWith({ workspaceId: "wks_7" });
    expect(screen.queryByRole("button", { name: /Create workspace for issue 7/ })).toBeNull();
  });

  it("shows a leftover branch instead of a create button", async () => {
    readySettings(prefs());
    oneProject([issue(7, { orphanBranch: "issue/7-old" })]);
    renderScreen();

    expect(await screen.findByText("Local branch issue/7-old exists without a workspace")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create workspace for issue 7/ })).toBeNull();
  });

  it("links to a workspace for the issue on another host", async () => {
    readySettings(prefs());
    oneProject([issue(7)]);
    host.hosts = [
      { serverId: "srv_here", label: "Laptop", status: "online" },
      { serverId: "srv_box", label: "Build box", status: "online" },
    ];
    host.remoteWorkspaces.set("srv_box", [
      {
        id: "wks_r",
        projectId: "x",
        title: "#7 Remote",
        name: "x",
        gitRuntime: { currentBranch: "", remoteUrl: "git@github.com:octo/repo.git" },
      },
    ]);
    renderScreen();

    fireEvent.click(await screen.findByRole("link", { name: "Open workspace #7 Remote on Build box" }));
    expect(navigation.openWorkspace).toHaveBeenCalledWith({ workspaceId: "wks_r", serverId: "srv_box" });
  });

  it("puts the metadata on the title line in compact density", async () => {
    readySettings(prefs({ density: "compact" }));
    oneProject([issue(7)]);
    renderScreen();

    const meta = await screen.findByText(/^#7 opened/);
    const title = screen.getByText("Issue 7");
    expect(title.closest("[role=link]")!.parentElement!.contains(meta)).toBe(true);
  });
});

// --- Project picker -----------------------------------------------------------------------------

describe("issues screen: project picker", () => {
  it("is hidden when there is only one project", async () => {
    readySettings(prefs());
    oneProject([issue(1)]);
    renderScreen();

    await screen.findByText("Issue 1");
    expect(screen.queryAllByRole("tab")).toEqual([]);
  });

  it("offers one choice per project and shows only the selected project's issues", async () => {
    readySettings(prefs());
    serveProjects([project("octo/a"), project("octo/b", { otherProjects: ["b-ios"] })]);
    serveOptions();
    const requests = servePages({ "p-octo/a": [issue(1)], "p-octo/b": [issue(2)] });
    renderScreen();

    await screen.findByText("Issue 1");
    expect(screen.getAllByRole("tab").map((r) => [r.getAttribute("aria-label"), r.getAttribute("aria-selected")])).toEqual([
      ["a (octo/a)", "true"],
      ["b (octo/b, also b-ios)", "false"],
    ]);
    expect(screen.queryByText("Issue 2")).toBeNull();
    expect(requests.map((r) => r.projectId)).toEqual(["p-octo/a"]);
  });

  it("switches project, saving the choice and starting on page 1", async () => {
    const saves = readySettings(prefs());
    serveProjects([project("octo/a"), project("Octo/B")]);
    serveOptions();
    const requests = servePages({
      "p-octo/a": Array.from({ length: 30 }, (_, i) => issue(i + 1)),
      "p-Octo/B": [issue(99)],
    });
    renderScreen();
    await screen.findByText("Issue 1");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Issue 26");

    fireEvent.click(screen.getByRole("tab", { name: "B (Octo/B)" }));

    expect(await screen.findByText("Issue 99")).toBeTruthy();
    expect(screen.queryByText("Issue 26")).toBeNull();
    expect(requests.at(-1)).toEqual({ projectId: "p-Octo/B", query: "assignee:@me", page: 1 });
    expect(screen.getByRole("tab", { name: "B (Octo/B)" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(saves.at(-1)?.selectedRepo).toBe("octo/b"));
  });

  it("shows each project's Paseo icon, and GitHub's repository icon when there is none", async () => {
    readySettings(prefs());
    serveProjects([
      project("octo/a", { icon: { data: "iVBORw0KGgo=", mimeType: "image/png" } }),
      project("octo/b", { icon: null }),
    ]);
    serveOptions();
    servePages({ "p-octo/a": [issue(1)], "p-octo/b": [] });
    renderScreen();
    await screen.findByText("Issue 1");

    const [a, b] = screen.getAllByRole("tab");
    expect(a.innerHTML).toContain("data:image/png;base64,iVBORw0KGgo=");
    expect(a.querySelector('[data-icon="BookMarked"]')).toBeNull();
    expect(b.querySelector('[data-icon="BookMarked"]')).not.toBeNull();
  });

  it("falls back from an SVG icon on native platforms, which cannot draw SVG", async () => {
    readySettings(prefs());
    serveProjects([
      project("octo/a", { icon: { data: "PHN2Zy8+", mimeType: "image/svg+xml" } }),
      project("octo/b"),
    ]);
    serveOptions();
    servePages({ "p-octo/a": [issue(1)], "p-octo/b": [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <IssuesScreen
          theme={theme}
          layout={{ compact: false, platform: "ios" }}
          host={{ id: "srv_here", label: "Laptop" }}
          navigation={navigation}
          params={{}}
        />
      </QueryClientProvider>,
    );
    await screen.findByText("Issue 1");

    const [a] = screen.getAllByRole("tab");
    expect(a.innerHTML).not.toContain("image/svg+xml");
    expect(a.querySelector('[data-icon="BookMarked"]')).not.toBeNull();
  });

  it("shows how many open issues are assigned to me next to each project", async () => {
    readySettings(prefs());
    serveProjects([project("octo/a"), project("octo/b")]);
    serveOptions();
    servePages({ "p-octo/a": [issue(1)], "p-octo/b": [] });
    const countRequests: unknown[] = [];
    host.rpcs.set("issues.assigned-counts", async (input) => {
      countRequests.push(input);
      return { counts: { "octo/a": 9, "octo/b": 0 } };
    });
    renderScreen();

    const [a, b] = await screen.findAllByRole("tab");
    await waitFor(() => expect(within(a).getByText("9")).toBeTruthy());
    expect(within(b).getByText("0")).toBeTruthy();
    expect(a.getAttribute("aria-label")).toContain("9 assigned to you");
    expect(countRequests).toEqual([{ repos: ["octo/a", "octo/b"] }]);
  });

  it("shows the tabs and issues without waiting for the counts", async () => {
    readySettings(prefs());
    serveProjects([project("octo/a"), project("octo/b")]);
    serveOptions();
    servePages({ "p-octo/a": [issue(1)], "p-octo/b": [] });
    host.rpcs.set("issues.assigned-counts", () => new Promise(() => {}));
    renderScreen();

    expect(await screen.findByText("Issue 1")).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("does not ask for counts when there is only one project", async () => {
    readySettings(prefs());
    oneProject([issue(1)]);
    const countRequests: unknown[] = [];
    host.rpcs.set("issues.assigned-counts", async (input) => {
      countRequests.push(input);
      return { counts: {} };
    });
    renderScreen();

    await screen.findByText("Issue 1");
    await settle();
    expect(countRequests).toEqual([]);
  });

  it("styles tabs like Paseo's workspace tabs: the selected chip is filled, the others muted", async () => {
    readySettings(prefs());
    serveProjects([project("octo/a"), project("octo/b")]);
    serveOptions();
    servePages({ "p-octo/a": [issue(1)], "p-octo/b": [] });
    renderScreen();
    await screen.findByText("Issue 1");

    const [a, b] = screen.getAllByRole("tab");
    // theme.colors.surface2 for the selected chip, as in Paseo; no underline.
    expect(getComputedStyle(a).backgroundColor).toBe("rgb(33, 38, 45)");
    expect(getComputedStyle(b).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(within(a).getByText("a")).color).toBe("rgb(230, 237, 243)");
    expect(getComputedStyle(within(b).getByText("b")).color).toBe("rgb(125, 133, 144)");
  });

  it("opens on the saved project", async () => {
    readySettings(prefs({ selectedRepo: "octo/b" }));
    serveProjects([project("octo/a"), project("octo/b")]);
    serveOptions();
    servePages({ "p-octo/a": [issue(1)], "p-octo/b": [issue(2)] });
    renderScreen();

    expect(await screen.findByText("Issue 2")).toBeTruthy();
    expect(screen.queryByText("Issue 1")).toBeNull();
  });

  it("falls back to the first project when the saved one is gone", async () => {
    readySettings(prefs({ selectedRepo: "octo/gone" }));
    serveProjects([project("octo/a"), project("octo/b")]);
    serveOptions();
    servePages({ "p-octo/a": [issue(1)], "p-octo/b": [issue(2)] });
    renderScreen();

    expect(await screen.findByText("Issue 1")).toBeTruthy();
  });
});

// --- Search -------------------------------------------------------------------------------------

describe("issues screen: search", () => {
  it("shows the query without the implied is:issue state:open", async () => {
    readySettings(prefs());
    oneProject([]);
    renderScreen();

    const box = (await screen.findByLabelText(/Search issues/)) as HTMLInputElement;
    expect(box.value).toBe("assignee:@me");
  });

  it("searches the selected project on Enter and saves the search", async () => {
    const saves = readySettings(prefs());
    const requests = oneProject([]);
    renderScreen();
    await screen.findByLabelText(/Search issues/);

    search("assignee:@me   label:bug");

    await waitFor(() =>
      expect(requests.at(-1)).toEqual({ projectId: "p-octo/repo", query: "assignee:@me label:bug", page: 1 }),
    );
    expect(saves.at(-1)?.searchQuery).toBe("assignee:@me label:bug");
  });

  it("clears to every open issue and offers a way back to my issues", async () => {
    readySettings(prefs());
    const requests = oneProject([]);
    renderScreen();
    await screen.findByLabelText(/Search issues/);

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(requests.at(-1)?.query).toBe(""));

    fireEvent.click(screen.getByRole("button", { name: "Assigned to me" }));
    await waitFor(() => expect(requests.at(-1)?.query).toBe("assignee:@me"));
  });

  it("sits between the project picker and the table, whose header holds the filters", async () => {
    readySettings(prefs());
    serveProjects([project("octo/a"), project("octo/b")]);
    serveOptions();
    servePages({ "p-octo/a": [issue(1)], "p-octo/b": [] });
    renderScreen();
    await screen.findByText("Issue 1");

    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const picker = screen.getAllByRole("tab")[0];
    const searchBox = screen.getByLabelText(/Search issues/);
    const filters = screen.getByRole("button", { name: "Author" });
    const count = screen.getByText("1 Open");
    const table = screen.getByText("Issue 1");
    expect(follows(picker, searchBox)).toBe(true);
    expect(follows(searchBox, count)).toBe(true);
    expect(follows(count, filters)).toBe(true);
    expect(follows(filters, table)).toBe(true);
    // The count and the filters share the table header, as on github.com.
    let header = count.parentElement!;
    while (!header.contains(filters)) header = header.parentElement!;
    expect(header.contains(table)).toBe(false);
  });
});

// --- Filter bar ---------------------------------------------------------------------------------

describe("issues screen: filter bar", () => {
  const options: Options = {
    me: "ajma",
    labels: [
      { name: "android", color: "037501", description: null },
      { name: "good first issue", color: "7057ff", description: "Good for newcomers" },
    ],
    milestones: [{ title: "PEM1 · Early Adopter Program", description: null }],
    users: [
      { login: "ajma", avatarUrl: null },
      { login: "octocat", avatarUrl: "https://avatars.example/octocat" },
    ],
    types: [{ name: "Bug", color: "RED", description: "An unexpected problem" }],
  };

  function setUp(query = "assignee:@me") {
    const saves = readySettings(prefs({ searchQuery: query }));
    serveProjects([project("octo/repo")]);
    const optionRequests = serveOptions(options);
    const requests = servePages({ "p-octo/repo": [issue(1)] });
    renderScreen();
    return { saves, requests, optionRequests };
  }
  const openMenu = async (name: string) => {
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${name}`) }));
    return screen.findByRole("menu");
  };
  const row = (menu: HTMLElement, name: string) => within(menu).getByRole("menuitem", { name });

  it("has GitHub's filters and loads their options for the selected repository", async () => {
    const { optionRequests } = setUp();
    await screen.findByText("Issue 1");

    for (const name of ["Author", "Labels", "Milestones", "Assignees", "Types"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
    await waitFor(() => expect(optionRequests).toEqual([{ repo: "octo/repo" }]));
  });

  it("adds labels to the search, keeping the menu open for more", async () => {
    const { requests } = setUp();
    const menu = await openMenu("Labels");

    fireEvent.click(await within(menu).findByRole("menuitem", { name: "good first issue" }));
    await waitFor(() => expect(requests.at(-1)?.query).toBe('assignee:@me label:"good first issue"'));
    fireEvent.click(row(screen.getByRole("menu"), "android"));
    await waitFor(() => expect(requests.at(-1)?.query).toBe('assignee:@me label:"good first issue" label:android'));

    expect(row(screen.getByRole("menu"), "android").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Labels, 2 applied" })).toBeTruthy();
    expect((screen.getByLabelText(/Search issues/) as HTMLInputElement).value).toBe(
      'assignee:@me label:"good first issue" label:android',
    );
  });

  it("counts only labels; a single-choice filter in use shows bold with no count", async () => {
    setUp('assignee:@me author:octocat milestone:"PEM1 · Early Adopter Program" type:Bug label:android');
    await screen.findByText("Issue 1");

    expect(screen.getByRole("button", { name: "Labels, 1 applied" })).toBeTruthy();
    for (const name of ["Author", "Milestones", "Assignees", "Types"]) {
      const button = screen.getByRole("button", { name: `${name}, filtered` });
      expect(within(button).queryByText("1")).toBeNull();
      expect(getComputedStyle(within(button).getByText(name)).fontWeight).toBe("600");
    }
  });

  it("shows the signed-in user as the current assignee, and offers nobody", async () => {
    const { requests } = setUp();
    const menu = await openMenu("Assignees");

    expect((await within(menu).findByRole("menuitem", { name: "ajma" })).getAttribute("aria-checked")).toBe("true");
    expect(row(menu, "octocat").getAttribute("aria-checked")).toBe("false");

    fireEvent.click(row(menu, "Assigned to nobody"));
    await waitFor(() => expect(requests.at(-1)?.query).toBe("no:assignee"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("filters by author, writing @me for yourself, and closes", async () => {
    const { requests } = setUp("");
    const menu = await openMenu("Author");

    fireEvent.click(await within(menu).findByRole("menuitem", { name: "ajma" }));

    await waitFor(() => expect(requests.at(-1)?.query).toBe("author:@me"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("lets you type any login, as on GitHub", async () => {
    const { requests } = setUp("");
    const menu = await openMenu("Author");
    await within(menu).findByRole("menuitem", { name: "ajma" });

    fireEvent.change(within(menu).getByLabelText("Filter author"), { target: { value: "someone-else" } });
    fireEvent.click(row(screen.getByRole("menu"), "someone-else"));

    await waitFor(() => expect(requests.at(-1)?.query).toBe("author:someone-else"));
  });

  it("narrows a menu to what you type", async () => {
    setUp();
    const menu = await openMenu("Labels");
    await within(menu).findByRole("menuitem", { name: "android" });

    fireEvent.change(within(menu).getByLabelText("Filter labels"), { target: { value: "GOOD" } });

    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "android" })).toBeNull();
    expect(row(screen.getByRole("menu"), "good first issue")).toBeTruthy();
  });

  it("filters by milestone and type, quoting names with spaces", async () => {
    const { requests } = setUp("");
    const milestones = await openMenu("Milestones");
    fireEvent.click(await within(milestones).findByRole("menuitem", { name: "PEM1 · Early Adopter Program" }));
    await waitFor(() => expect(requests.at(-1)?.query).toBe('milestone:"PEM1 · Early Adopter Program"'));

    fireEvent.click(row(await openMenu("Types"), "Bug"));
    await waitFor(() => expect(requests.at(-1)?.query).toBe('milestone:"PEM1 · Early Adopter Program" type:Bug'));
  });

  it("removes a single-choice filter when it is picked again", async () => {
    const { requests } = setUp("type:Bug");
    const menu = await openMenu("Types");
    fireEvent.click(await within(menu).findByRole("menuitem", { name: "Bug" }));
    await waitFor(() => expect(requests.at(-1)?.query).toBe(""));
  });

  it("paints the open menu above the layer that closes it, so its entries can be pressed", async () => {
    setUp();
    const menu = await openMenu("Labels");
    const entry = await within(menu).findByRole("menuitem", { name: "android" });
    const search = within(menu).getByLabelText("Filter labels");

    for (const layer of screen.getAllByLabelText("Close filter menu")) {
      expect(paintsAbove(entry, layer)).toBe(true);
      expect(paintsAbove(search, layer)).toBe(true);
    }
    // The other filter buttons stay pressable, to switch menus.
    const authors = screen.getByRole("button", { name: /^Author/ });
    for (const layer of screen.getAllByLabelText("Close filter menu")) expect(paintsAbove(authors, layer)).toBe(true);
  });

  it("covers the issue rows while a menu is open, so pressing one closes the menu", async () => {
    setUp();
    await openMenu("Labels");
    const create = screen.getByRole("button", { name: "Create workspace for issue 1" });

    const covering = screen.getAllByLabelText("Close filter menu").filter((layer) => paintsAbove(layer, create));
    expect(covering.length).toBeGreaterThan(0);
    fireEvent.click(covering[0]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the menu when anything outside it is pressed", async () => {
    setUp();
    // One layer covers the screen around the table, one covers the table's rows.
    for (const index of [0, 1]) {
      await openMenu("Labels");
      const layers = screen.getAllByLabelText("Close filter menu");
      expect(layers).toHaveLength(2);
      fireEvent.click(layers[index]);
      expect(screen.queryByRole("menu")).toBeNull();
    }
  });

  it("uses a sheet instead of a dropdown on narrow layouts", async () => {
    readySettings(prefs());
    serveProjects([project("octo/repo")]);
    serveOptions(options);
    servePages({ "p-octo/repo": [issue(1)] });
    renderScreen({ compact: true });

    fireEvent.click(await screen.findByRole("button", { name: /^Labels/ }));

    expect(screen.getByRole("dialog", { name: "Filter by label" })).toBeTruthy();
  });

  it("uses a sheet on native platforms, which cannot press a dropdown hanging below the header", async () => {
    readySettings(prefs());
    serveProjects([project("octo/repo")]);
    serveOptions(options);
    servePages({ "p-octo/repo": [issue(1)] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <IssuesScreen
          theme={theme}
          layout={{ compact: false, platform: "ios" }}
          host={{ id: "srv_here", label: "Laptop" }}
          navigation={navigation}
          params={{}}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /^Labels/ }));

    expect(screen.getByRole("dialog", { name: "Filter by label" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes an open menu when the page changes", async () => {
    readySettings(prefs());
    serveProjects([project("octo/repo")]);
    serveOptions(options);
    servePages({ "p-octo/repo": Array.from({ length: 30 }, (_, i) => issue(30 - i)) });
    renderScreen();
    await openMenu("Labels");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("switches density and saves it", async () => {
    const { saves } = setUp();
    await screen.findByText("Issue 1");

    fireEvent.click(screen.getByRole("button", { name: "Compact density" }));

    await waitFor(() => expect(saves.at(-1)?.density).toBe("compact"));
  });

  it("names each density on hover, like GitHub's tooltips", async () => {
    setUp();
    await screen.findByText("Issue 1");
    const compact = screen.getByRole("button", { name: "Compact density" });

    // A mouse, not a finger: react-native-web ignores hover from touch input.
    const mouse = (type: string) => {
      const event = new MouseEvent(type, { bubbles: false });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      act(() => void compact.dispatchEvent(event));
    };

    mouse("pointerenter");
    mouse("mouseenter");
    expect(await screen.findByText("Compact")).toBeTruthy();
    mouse("pointerleave");
    mouse("mouseleave");
    await waitFor(() => expect(screen.queryByText("Compact")).toBeNull());
  });
});

// --- Paging -------------------------------------------------------------------------------------

describe("issues screen: paging", () => {
  const many = Array.from({ length: 60 }, (_, i) => issue(60 - i));

  it("shows page 1 with GitHub's pager and the full count", async () => {
    readySettings(prefs());
    oneProject(many);
    renderScreen();

    await screen.findByText("Issue 60");
    expect(screen.getAllByText(/^Issue \d+$/)).toHaveLength(25);
    expect(screen.getByText("60 Open")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Page 1" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Previous page" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("fetches each page from the server only when it is opened", async () => {
    readySettings(prefs());
    const requests = oneProject(many);
    renderScreen();
    await screen.findByText("Issue 60");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Issue 35")).toBeTruthy();
    expect(screen.queryByText("Issue 60")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Page 3" }));
    expect(await screen.findByText("Issue 10")).toBeTruthy();
    expect(screen.getAllByText(/^Issue \d+$/)).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Next page" }).getAttribute("aria-disabled")).toBe("true");
    expect(requests.map((r) => r.page)).toEqual([1, 2, 3]);
  });

  it("returns to a page already seen without asking the server again", async () => {
    readySettings(prefs());
    const requests = oneProject(many);
    renderScreen();
    await screen.findByText("Issue 60");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Issue 35");

    fireEvent.click(screen.getByRole("button", { name: "Page 1" }));

    expect(await screen.findByText("Issue 60")).toBeTruthy();
    expect(requests).toHaveLength(2);
  });

  it("returns to page 1 after a new search", async () => {
    readySettings(prefs());
    const requests = oneProject(many);
    renderScreen();
    await screen.findByText("Issue 60");
    fireEvent.click(screen.getByRole("button", { name: "Page 3" }));
    await screen.findByText("Issue 10");

    search("label:bug");

    await waitFor(() => expect(requests.at(-1)).toMatchObject({ query: "label:bug", page: 1 }));
  });

  it("stops at page 40, GitHub's search limit, and formats large counts", async () => {
    readySettings(prefs());
    serveProjects([project("octo/repo")]);
    serveOptions();
    host.rpcs.set("issues.page", async () => ({ issues: many.slice(0, 25), totalCount: 5432 }));
    renderScreen();
    await screen.findByText("Issue 60");

    expect(screen.getByText("5,432 Open")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Page 40" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Page 41" })).toBeNull();
  });

  it("shows no pager for a single page", async () => {
    readySettings(prefs());
    oneProject(many.slice(0, 25));
    renderScreen();
    await screen.findByText("Issue 60");

    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("shows Page X of Y instead of numbers on narrow layouts", async () => {
    readySettings(prefs());
    oneProject(many);
    renderScreen({ compact: true });
    await screen.findByText("Issue 60");

    expect(screen.getByText("Page 1 of 3")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Page 2" })).toBeNull();
  });
});

// --- Themes -------------------------------------------------------------------------------------

describe("issues screen: themes", () => {
  const bug = { name: "bug", color: "d73a4a" };
  const labelBox = () => getComputedStyle(screen.getByText("bug").parentElement!);
  const openIconColors = () =>
    [...document.querySelectorAll('[data-icon="CircleDot"]')].map((el) => el.getAttribute("data-color"));

  it("uses solid labels with contrasting text and GitHub's light green on light themes", async () => {
    readySettings(prefs());
    oneProject([issue(7, { labels: [bug] })]);
    renderScreen({ light: true });
    await screen.findByText("Issue 7");

    expect(labelBox().backgroundColor).toBe("rgb(215, 58, 74)");
    expect(getComputedStyle(screen.getByText("bug")).color).toBe("rgb(255, 255, 255)");
    expect(new Set(openIconColors())).toEqual(new Set(["#1a7f37"]));
  });

  it("uses tinted labels and GitHub's dark green on dark themes", async () => {
    readySettings(prefs());
    oneProject([issue(7, { labels: [bug] })]);
    renderScreen();
    await screen.findByText("Issue 7");

    expect(labelBox().backgroundColor).toBe("rgba(215, 58, 74, 0.18)");
    expect(new Set(openIconColors())).toEqual(new Set(["#3fb950"]));
  });

  it("takes every other color from the theme", async () => {
    readySettings(prefs());
    oneProject([issue(7)]);
    renderScreen({ light: true });
    await screen.findByText("Issue 7");

    expect(getComputedStyle(screen.getByText("Issue 7")).color).toBe("rgb(31, 35, 40)");
    expect(getComputedStyle(screen.getByText(/^#7 opened/)).color).toBe("rgb(89, 99, 110)");
  });
});

// --- Creating -----------------------------------------------------------------------------------

describe("issues screen: creating a workspace", () => {
  it("creates a workspace from the main button", async () => {
    readySettings(prefs());
    oneProject([issue(7)]);
    const requests = serveCreate();
    renderScreen();

    fireEvent.click(await screen.findByRole("button", { name: "Create workspace for issue 7" }));

    await waitFor(() => expect(requests).toEqual([{ projectId: "p-octo/repo", number: 7, action: "create" }]));
    await waitFor(() => expect(host.toasts).toContainEqual({ message: "Created workspace for #7", variant: "success" }));
  });

  it("opens a dropdown under the arrow with the current choice checked, like GitHub's split buttons", async () => {
    readySettings(prefs({ agent: "claude/opus" }));
    oneProject([issue(7)]);
    renderScreen();

    const arrow = await screen.findByRole("button", { name: "More ways to create a workspace for issue 7" });
    fireEvent.click(arrow);

    const menu = screen.getByRole("menu", { name: "Create a workspace for #7" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(arrow.getAttribute("aria-expanded")).toBe("true");
    const [create, fix] = within(menu).getAllByRole("menuitemradio");
    expect(create.getAttribute("aria-label")).toBe("Create workspace");
    expect(create.getAttribute("aria-checked")).toBe("true");
    expect(fix.getAttribute("aria-checked")).toBe("false");
    expect(within(menu).getByText(/Also starts claude\/opus/)).toBeTruthy();
    expect(menu.querySelector('[data-icon="Wrench"]')).not.toBeNull();
  });

  it("switches the button to the chosen action without running it, then runs it from the button", async () => {
    readySettings(prefs({ agent: "claude/opus" }));
    oneProject([issue(7)]);
    const requests = serveCreate();
    renderScreen();

    fireEvent.click(await screen.findByRole("button", { name: "More ways to create a workspace for issue 7" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "Create and start an agent" }));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(requests).toEqual([]);
    const main = screen.getByRole("button", { name: "Create workspace and start an agent on issue 7" });
    expect(within(main).getByText("Create and start")).toBeTruthy();
    expect(main.querySelector('[data-icon="Wrench"]')).not.toBeNull();

    fireEvent.click(main);

    await waitFor(() => expect(requests).toEqual([{ projectId: "p-octo/repo", number: 7, action: "agent" }]));
    await waitFor(() =>
      expect(host.toasts).toContainEqual({
        message: "Created workspace for #7 and started claude/opus",
        variant: "success",
      }),
    );
  });

  it("keeps each issue's choice to itself", async () => {
    readySettings(prefs());
    oneProject([issue(7), issue(8)]);
    renderScreen();

    fireEvent.click(await screen.findByRole("button", { name: "More ways to create a workspace for issue 7" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "Create and start an agent" }));

    expect(screen.getByRole("button", { name: "Create workspace and start an agent on issue 7" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create workspace for issue 8" })).toBeTruthy();
  });

  it("closes the dropdown on a press outside it, which does not reach what is under it", async () => {
    readySettings(prefs());
    oneProject([issue(7), issue(8)]);
    const requests = serveCreate();
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "More ways to create a workspace for issue 7" }));
    const menu = screen.getByRole("menu");
    const entry = within(menu).getAllByRole("menuitemradio")[1];
    const otherCreate = screen.getByRole("button", { name: "Create workspace for issue 8" });
    const layers = screen.getAllByLabelText("Close menu");

    // The open dropdown is on top of every dismiss layer; the next row's button is under one.
    for (const layer of layers) expect(paintsAbove(entry, layer)).toBe(true);
    const covering = layers.filter((layer) => paintsAbove(layer, otherCreate));
    expect(covering.length).toBeGreaterThan(0);

    fireEvent.click(covering[0]);

    expect(screen.queryByRole("menu")).toBeNull();
    expect(requests).toEqual([]);
  });

  it("paints the dropdown above the pager, so a menu on the last row can be used", async () => {
    readySettings(prefs());
    oneProject(Array.from({ length: 30 }, (_, i) => issue(30 - i)));
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "More ways to create a workspace for issue 6" }));

    const entry = within(screen.getByRole("menu")).getAllByRole("menuitemradio")[0];
    expect(paintsAbove(entry, screen.getByRole("button", { name: "Next page" }))).toBe(true);
  });

  it("uses a sheet on native platforms, which cannot press a dropdown hanging outside its row", async () => {
    readySettings(prefs());
    oneProject([issue(7)]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <IssuesScreen
          theme={theme}
          layout={{ compact: true, platform: "ios" }}
          host={{ id: "srv_here", label: "Laptop" }}
          navigation={navigation}
          params={{}}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "More ways to create a workspace for issue 7" }));
    const sheet = screen.getByRole("dialog", { name: "Create a workspace for #7" });
    fireEvent.click(within(sheet).getByRole("menuitemradio", { name: "Create and start an agent" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Create workspace and start an agent on issue 7" })).toBeTruthy();
  });

  it("names the default agent when none is chosen", async () => {
    readySettings(prefs());
    oneProject([issue(7)]);
    renderScreen();

    fireEvent.click(await screen.findByRole("button", { name: "More ways to create a workspace for issue 7" }));
    expect(within(screen.getByRole("menu")).getByText(/Also starts the host's default agent/)).toBeTruthy();
  });

  it("disables other create buttons while one is running and reports failures", async () => {
    readySettings(prefs());
    oneProject([issue(7), issue(8)]);
    let fail!: (error: Error) => void;
    host.rpcs.set("issues.create-workspace", () => new Promise((_resolve, reject) => (fail = reject)));
    renderScreen();

    fireEvent.click(await screen.findByRole("button", { name: "Create workspace for issue 7" }));
    expect(await screen.findByText("Creating…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create workspace for issue 8" }).getAttribute("aria-disabled")).toBe(
      "true",
    );

    await act(async () => fail(new Error("#7 already has local branch issue/7-x")));

    await waitFor(() =>
      expect(host.toasts).toContainEqual({ message: "#7: #7 already has local branch issue/7-x", variant: "error" }),
    );
    expect(
      screen.getByRole("button", { name: "Create workspace for issue 8" }).getAttribute("aria-disabled"),
    ).not.toBe("true");
  });

  it("refreshes the issues after creating", async () => {
    readySettings(prefs());
    const requests = oneProject([issue(7)]);
    serveCreate();
    renderScreen();

    fireEvent.click(await screen.findByRole("button", { name: "Create workspace for issue 7" }));

    await waitFor(() => expect(requests.length).toBe(2));
  });
});

// --- Other hosts --------------------------------------------------------------------------------

describe("issues screen: projects on other hosts", () => {
  const remoteProject = (repo: string) => ({
    projectId: `rp-${repo}`,
    projectKey: `remote:github.com/${repo}`,
    projectDisplayName: repo.split("/")[1],
    projectCustomName: null,
    projectRootPath: `/srv/${repo.split("/")[1]}`,
    projectKind: "git",
  });

  /** One other online host, "Build box", with the given projects and workspaces. */
  function buildBox(projects: unknown[], workspaces: unknown[] = []) {
    host.hosts = [
      { serverId: "srv_here", label: "Laptop", status: "online" },
      { serverId: "srv_box", label: "Build box", status: "online" },
    ];
    host.remoteProjects.set("srv_box", projects);
    host.remoteWorkspaces.set("srv_box", workspaces);
  }

  it("shows PR status for an issue in a project only another host has", async () => {
    readySettings(prefs({ selectedRepo: "octo/there" }));
    serveProjects([]);
    serveOptions();
    servePages({ "octo/there": [issue(9)] });
    buildBox([remoteProject("octo/there")]);
    const fetch = vi.fn(async () => ({ pullRequests: { "9": [pullRequest()] } }));
    host.rpcs.set("issues.pull-requests", fetch);
    renderScreen({ compact: true });
    expect(await screen.findByText("Mergeable")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith({ repo: "octo/there", numbers: [9] });
  });

  it("offers a project only another host has, labelled with that host", async () => {
    readySettings(prefs());
    serveProjects([project("octo/here")]);
    serveOptions();
    servePages({ "p-octo/here": [issue(1)], "octo/there": [issue(9)] });
    buildBox([remoteProject("octo/there")]);
    renderScreen();

    expect(await screen.findByRole("tab", { name: "there (octo/there) on Build box" })).toBeTruthy();
  });

  it("shows that project's issues, searched by repository, labelled with its host", async () => {
    readySettings(prefs({ selectedRepo: "octo/there" }));
    serveProjects([project("octo/here")]);
    serveOptions();
    const requests = servePages({ "p-octo/here": [], "octo/there": [issue(9, { title: "Remote issue" })] });
    buildBox([remoteProject("octo/there")]);
    renderScreen();

    expect(await screen.findByText("Remote issue")).toBeTruthy();
    expect(screen.getByText("on Build box")).toBeTruthy();
    expect(requests.at(-1)).toEqual({ repo: "octo/there", query: "assignee:@me", page: 1 });
  });

  it("does not offer a repository this host also has", async () => {
    readySettings(prefs());
    serveProjects([project("octo/shared")]);
    serveOptions();
    servePages({ "p-octo/shared": [issue(1)] });
    buildBox([remoteProject("Octo/Shared")]);
    renderScreen();

    await screen.findByText("Issue 1");
    await settle();
    expect(screen.queryAllByRole("tab")).toEqual([]);
  });

  it("creates the workspace on the host that has the project", async () => {
    readySettings(prefs({ selectedRepo: "octo/there" }));
    serveProjects([project("octo/here")]);
    serveOptions();
    servePages({ "p-octo/here": [], "octo/there": [issue(9, { title: "Remote issue" })] });
    buildBox([remoteProject("octo/there")]);
    const localCreates = serveCreate();
    host.rpcs.set("issues.details", async () => ({
      title: "Remote issue",
      state: "OPEN",
      url: "https://github.com/octo/there/issues/9",
      defaultBranch: "main",
    }));
    renderScreen();

    fireEvent.click(await screen.findByRole("button", { name: "Create workspace for issue 9" }));

    await waitFor(() => expect(host.remoteCreated).toHaveLength(1));
    expect(host.remoteCreated[0]).toMatchObject({
      serverId: "srv_box",
      options: {
        title: "#9 Remote issue",
        source: { cwd: "/srv/there", branchName: "issue/9-remote-issue", baseBranch: "origin/main" },
      },
    });
    expect(localCreates).toEqual([]);
    await waitFor(() =>
      expect(host.toasts).toContainEqual({ message: "Created workspace for #9 on Build box", variant: "success" }),
    );
  });

  it("names the other host's default agent in the fix option", async () => {
    readySettings(prefs({ selectedRepo: "octo/there" }));
    serveProjects([project("octo/here")]);
    serveOptions();
    servePages({ "p-octo/here": [], "octo/there": [issue(9)] });
    buildBox([remoteProject("octo/there")]);
    renderScreen();

    fireEvent.click(await screen.findByRole("button", { name: "More ways to create a workspace for issue 9" }));
    expect(within(screen.getByRole("menu")).getByText(/Also starts Build box's default agent/)).toBeTruthy();
  });

  it("opens the other host's workspace for a covered issue", async () => {
    readySettings(prefs({ selectedRepo: "octo/there" }));
    serveProjects([project("octo/here")]);
    serveOptions();
    servePages({ "p-octo/here": [], "octo/there": [issue(9)] });
    buildBox(
      [remoteProject("octo/there")],
      [
        {
          id: "wks_9",
          projectId: "rp",
          title: "#9 Remote",
          name: "x",
          gitRuntime: { currentBranch: "", remoteUrl: "git@github.com:octo/there.git" },
        },
      ],
    );
    renderScreen();

    fireEvent.click(await screen.findByRole("button", { name: "Open workspace for issue 9" }));

    expect(navigation.openWorkspace).toHaveBeenCalledWith({ workspaceId: "wks_9", serverId: "srv_box" });
  });

  it("ignores offline hosts", async () => {
    readySettings(prefs());
    serveProjects([project("octo/here")]);
    serveOptions();
    servePages({ "p-octo/here": [issue(1)] });
    buildBox([remoteProject("octo/there")]);
    host.hosts[1].status = "offline";
    renderScreen();

    await screen.findByText("Issue 1");
    await settle();
    expect(screen.queryAllByRole("tab")).toEqual([]);
  });
});
