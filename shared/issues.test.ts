import { describe, expect, it } from "vitest";
import {
  agentAvailable,
  effortChoices,
  offeredEffort,
  effectiveAgentPrompt,
  branchName,
  branchPrefixError,
  defaultAgent,
  DEFAULT_AGENT_PROMPT,
  DEFAULT_PREFERENCES,
  DEFAULT_QUERY,
  effectivePreferences,
  issueMatcher,
  issuesPageRpc,
  MAX_RESULTS,
  parseOwners,
  PAGE_SIZE,
  pageCountFor,
  parseGitHubRemote,
  parseProjectKey,
  preferences,
  renderPrompt,
} from "./issues";

describe("parseGitHubRemote", () => {
  it.each([
    ["git@github.com:acme-labs/widgets.git", "acme-labs/widgets"],
    ["https://github.com/octo/repo", "octo/repo"],
    ["https://github.com/octo/repo.git/", "octo/repo"],
    ["https://user:token@github.com/octo/repo.git", "octo/repo"],
    ["ssh://git@github.com/octo/repo.git", "octo/repo"],
    ["ssh://git@github.com:22/octo/repo.git", "octo/repo"],
    ["git://github.com/octo/repo.git", "octo/repo"],
    ["git@github.com:Octo/Repo.With.Dots.git", "Octo/Repo.With.Dots"],
    ["  git@GitHub.com:octo/repo.git\n", "octo/repo"],
  ])("reads %s as %s", (url, slug) => {
    expect(parseGitHubRemote(url)).toBe(slug);
  });

  it.each([
    "git@gitlab.com:octo/repo.git",
    "https://github.example.com/octo/repo",
    "https://notgithub.com/octo/repo",
    "https://github.com/octo",
    "/srv/git/repo.git",
    "",
  ])("rejects %j", (url) => {
    expect(parseGitHubRemote(url)).toBeNull();
  });
});

describe("issueMatcher", () => {
  const match = issueMatcher(12, "feat/");

  it("matches a workspace title that starts with #number", () => {
    expect(match.title("#12 Fix the thing")).toBe(true);
    expect(match.title("#12")).toBe(true);
  });

  it("does not match other numbers or #number later in the title", () => {
    expect(match.title("#123 Something else")).toBe(false);
    expect(match.title("#1 Something")).toBe(false);
    expect(match.title("Follow-up to #12")).toBe(false);
  });

  it("matches branches with the configured prefix or number- after a slash", () => {
    expect(match.branch("feat/12-fix-the-thing")).toBe(true);
    expect(match.branch("issue/12-from-an-older-prefix")).toBe(true);
    expect(match.branch("12-bare")).toBe(true);
  });

  it("does not match a different number or digits inside a word", () => {
    expect(match.branch("feat/123-other")).toBe(false);
    expect(match.branch("feat/112-other")).toBe(false);
    expect(match.branch("v2.12-release")).toBe(false);
    expect(match.branch("main")).toBe(false);
  });

  it("treats regex characters in the prefix literally", () => {
    const dotted = issueMatcher(7, "a.b/");
    expect(dotted.branch("a.b/7-x")).toBe(true);
    expect(dotted.branch("axb7-x")).toBe(false);
  });
});

describe("branchPrefixError", () => {
  it.each(["", "issue/", "feat/", "ajma/issues/", "fix-", "x"])("accepts %j", (prefix) => {
    expect(branchPrefixError(prefix)).toBeNull();
  });

  it.each(["-x", "/issue", ".hidden", "a..b", "a//b", "a/.b", "has space/", "a~b", "a:b"])("rejects %j", (prefix) => {
    expect(branchPrefixError(prefix)).not.toBeNull();
  });
});

describe("preferences", () => {
  it("fills every field from {} so a missing document gets defaults", () => {
    expect(preferences.schema.parse({})).toEqual({
      branchPrefix: "issue/",
      selectedRepo: "",
      searchQuery: DEFAULT_QUERY,
      density: "comfortable",
      sort: "created-desc",
      agent: "",
      effort: "",
      agentPrompt: DEFAULT_AGENT_PROMPT,
      owners: [],
    });
    expect(DEFAULT_PREFERENCES).toEqual(preferences.schema.parse({}));
  });

  it("keeps saved values and defaults fields added after they were saved", () => {
    const stored = { branchPrefix: "fix/" };
    expect(preferences.schema.parse(stored)).toMatchObject({ ...stored, selectedRepo: "", density: "comfortable" });
  });

  it("drops retired settings from documents saved before they were removed", () => {
    const parsed = preferences.schema.parse({ hideTitlePattern: "^iOS\\b", hiddenRepos: ["o/r"] });
    expect(parsed).not.toHaveProperty("hideTitlePattern");
    expect(parsed).not.toHaveProperty("hiddenRepos");
  });

  it("defaults the search to issues assigned to me", () => {
    expect(DEFAULT_QUERY).toBe("assignee:@me");
  });
});

describe("effectivePreferences", () => {
  it("passes valid values through", () => {
    const values = { ...DEFAULT_PREFERENCES, branchPrefix: "fix/", selectedRepo: "a/b", agent: "claude/opus" };
    expect(effectivePreferences(values)).toEqual(values);
  });

  it("drops owners that are not GitHub logins", () => {
    const values = { ...DEFAULT_PREFERENCES, owners: ["Klartika", "bad owner", "-x", "octo-org"] };
    expect(effectivePreferences(values).owners).toEqual(["Klartika", "octo-org"]);
  });

  it("falls back to defaults for values that would break creating", () => {
    const values = { ...DEFAULT_PREFERENCES, branchPrefix: "-bad", agentPrompt: "   " };
    expect(effectivePreferences(values)).toMatchObject({ branchPrefix: "issue/", agentPrompt: DEFAULT_AGENT_PROMPT });
  });
});

describe("parseOwners", () => {
  it("splits on commas and spaces, dropping repeats in any case", () => {
    expect(parseOwners(" Klartika, Elegia-io  portico-ch,klartika ")).toEqual(["Klartika", "Elegia-io", "portico-ch"]);
  });

  it("is empty for empty text", () => {
    expect(parseOwners("  , ")).toEqual([]);
  });

  it.each(["octo/repo", "-octo", "octo-", "a_b", "@me"])("rejects %j", (text) => {
    expect(parseOwners(`ok, ${text}`)).toBeNull();
  });

  it("rejects more than 20 owners", () => {
    expect(parseOwners(Array.from({ length: 21 }, (_, i) => `o${i}`).join(","))).toBeNull();
  });
});

describe("issuesPageRpc input", () => {
  const parse = (input: object) => issuesPageRpc.input.safeParse({ query: "", page: 1, ...input }).success;

  it("takes exactly one of projectId, repo and owners", () => {
    expect(parse({ projectId: "p" })).toBe(true);
    expect(parse({ repo: "o/r" })).toBe(true);
    expect(parse({ owners: ["octo-org"] })).toBe(true);
    expect(parse({})).toBe(false);
    expect(parse({ projectId: "p", owners: ["octo-org"] })).toBe(false);
  });

  it("refuses owners that would change the search", () => {
    expect(parse({ owners: ["octo-org repo:x/y"] })).toBe(false);
    expect(parse({ owners: [] })).toBe(false);
  });
});

describe("effectiveAgentPrompt", () => {
  it("keeps a prompt the user wrote", () => {
    expect(effectiveAgentPrompt("Do {number}")).toBe("Do {number}");
  });

  it("uses the default for an empty prompt", () => {
    expect(effectiveAgentPrompt("")).toBe(DEFAULT_AGENT_PROMPT);
    expect(effectiveAgentPrompt("  \n")).toBe(DEFAULT_AGENT_PROMPT);
  });

  it("words the default for any kind of issue, not only bugs", () => {
    expect(DEFAULT_AGENT_PROMPT.startsWith("Work on GitHub issue #{number}")).toBe(true);
    expect(DEFAULT_AGENT_PROMPT).toContain("If it reports a bug");
    expect(DEFAULT_AGENT_PROMPT).toContain("Otherwise do what it asks");
  });
});

describe("renderPrompt", () => {
  const values = { number: "42", title: "Crash on start", url: "https://github.com/o/r/issues/42", repo: "o/r" };

  it("fills every placeholder, repeatedly", () => {
    expect(renderPrompt("{repo}#{number} {title} {url} #{number}", values)).toBe(
      "o/r#42 Crash on start https://github.com/o/r/issues/42 #42",
    );
  });

  it("leaves unknown braces alone and does not re-expand inserted text", () => {
    expect(renderPrompt("{body} {title}", { ...values, title: "uses {number}" })).toBe("{body} uses {number}");
  });

  it("gives the default prompt the issue and a way to read it", () => {
    const text = renderPrompt(DEFAULT_AGENT_PROMPT, values);
    expect(text).toContain("#42");
    expect(text).toContain("Crash on start");
    expect(text).toContain(values.url);
    expect(text).toContain("gh issue view 42 --repo o/r --comments");
    expect(text).not.toMatch(/\{(number|title|url|repo)\}/);
  });
});

describe("pageCountFor", () => {
  it("pages 25 at a time, like github.com", () => {
    expect(PAGE_SIZE).toBe(25);
    expect(pageCountFor(25)).toBe(1);
    expect(pageCountFor(26)).toBe(2);
    expect(pageCountFor(221)).toBe(9);
  });

  it("always has a page, even with no results", () => {
    expect(pageCountFor(0)).toBe(1);
  });

  it("stops at GitHub's 1,000-result search limit", () => {
    expect(MAX_RESULTS).toBe(1000);
    expect(pageCountFor(1000)).toBe(40);
    expect(pageCountFor(5432)).toBe(40);
  });
});

describe("parseProjectKey", () => {
  it("reads the repository from a GitHub project key", () => {
    expect(parseProjectKey("remote:github.com/acme-labs/widgets")).toBe("acme-labs/widgets");
  });

  it.each([
    "host:srv_1:/Users/me/code/app",
    "remote:gitlab.com/octo/repo",
    "remote:github.com/octo",
    "remote:github.com/octo/repo/extra",
    "",
    null,
    undefined,
  ])("rejects %j", (key) => {
    expect(parseProjectKey(key)).toBeNull();
  });
});

describe("branchName", () => {
  it.each([
    ["Fix it", "issue/9-fix-it"],
    ["Crash on start: when the config file is missing (really!)", "issue/9-crash-on-start-when-the-config-file-is"],
    ["Supercalifragilisticexpialidocious-and-a-half-words", "issue/9-supercalifragilisticexpialidocious-and-a"],
    ["Averyveryveryveryveryveryveryverylongsingleword", "issue/9-averyveryveryveryveryveryveryverylongsin"],
    ["🐛🔥", "issue/9"],
  ])("names %j as %s", (title, branch) => {
    expect(branchName("issue/", 9, title)).toBe(branch);
  });

  it("uses the prefix as given", () => {
    expect(branchName("ajma/", 3, "A b")).toBe("ajma/3-a-b");
    expect(branchName("", 3, "A b")).toBe("3-a-b");
  });
});

describe("defaultAgent and agentAvailable", () => {
  const providers = [
    { provider: "copilot", status: "unavailable", models: [{ id: "x" }] },
    { provider: "codex", status: "ready", enabled: false, models: [{ id: "gpt" }] },
    {
      provider: "claude",
      status: "ready",
      models: [{ id: "hidden", isSelectable: false }, { id: "sonnet" }, { id: "opus", isDefault: true }],
    },
  ];

  it("picks the first ready, enabled provider and its default model", () => {
    expect(defaultAgent(providers)).toBe("claude/opus");
  });

  it("falls back to the first selectable model, and to null when nothing is ready", () => {
    expect(defaultAgent([{ provider: "pi", status: "ready", models: [{ id: "a", isSelectable: false }, { id: "b" }] }])).toBe("pi/b");
    expect(defaultAgent([{ provider: "pi", status: "loading", models: [{ id: "a" }] }])).toBeNull();
    expect(defaultAgent([])).toBeNull();
  });

  it("knows whether a host offers a configured agent", () => {
    expect(agentAvailable(providers, "claude/sonnet")).toBe(true);
    expect(agentAvailable(providers, "claude/hidden")).toBe(false);
    expect(agentAvailable(providers, "codex/gpt")).toBe(false);
    expect(agentAvailable(providers, "copilot/x")).toBe(false);
    expect(agentAvailable(providers, "gemini/pro")).toBe(false);
  });
});

describe("effortChoices and offeredEffort", () => {
  const levels = [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
  ];
  const providers = [
    {
      provider: "claude",
      status: "ready",
      models: [
        { id: "opus", thinkingOptions: levels, defaultThinkingOptionId: "low" },
        { id: "sonnet", thinkingOptions: levels },
        { id: "haiku" },
      ],
    },
    { provider: "codex", status: "loading", models: [{ id: "gpt", thinkingOptions: levels }] },
  ];

  it("lists the model's levels and its default", () => {
    expect(effortChoices(providers, "claude/opus")).toEqual({
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
      defaultId: "low",
    });
    expect(effortChoices(providers, "claude/sonnet").defaultId).toBe("high");
  });

  it("offers nothing for a model without levels, or one the host does not offer", () => {
    expect(effortChoices(providers, "claude/haiku")).toEqual({ options: [], defaultId: null });
    expect(effortChoices(providers, "codex/gpt")).toEqual({ options: [], defaultId: null });
    expect(effortChoices(providers, "")).toEqual({ options: [], defaultId: null });
  });

  it("keeps an effort only when the model offers it", () => {
    expect(offeredEffort(providers, "claude/opus", "high")).toBe("high");
    expect(offeredEffort(providers, "claude/opus", "max")).toBeNull();
    expect(offeredEffort(providers, "claude/haiku", "high")).toBeNull();
    expect(offeredEffort(providers, "claude/opus", "")).toBeNull();
  });
});
