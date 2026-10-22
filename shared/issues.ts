import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** What the search box starts with. `is:issue state:open` is always added and never shown. */
export const DEFAULT_QUERY = "assignee:@me";

/** Issues per page, as on github.com. */
export const PAGE_SIZE = 25;
/** GitHub's search returns at most this many results, so pages stop at 40. */
export const MAX_RESULTS = 1000;

/** Pages available for `totalCount` matches; always at least one. */
export function pageCountFor(totalCount: number): number {
  return Math.max(1, Math.ceil(Math.min(totalCount, MAX_RESULTS) / PAGE_SIZE));
}

export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

/** GitHub's issue sort orders, as `<search API sort>-<order>`. */
export const SORTS = ["created-desc", "created-asc", "updated-desc", "updated-asc", "comments-desc", "reactions-desc"] as const;
export type Sort = (typeof SORTS)[number];
export const SORT_LABELS: Record<Sort, string> = {
  "created-desc": "Newest",
  "created-asc": "Oldest",
  "updated-desc": "Recently updated",
  "updated-asc": "Least recently updated",
  "comments-desc": "Most commented",
  "reactions-desc": "Most reactions",
};

export const DEFAULT_AGENT_PROMPT = `Work on GitHub issue #{number} in {repo}: {title}
{url}

Read the issue and its comments with \`gh issue view {number} --repo {repo} --comments\`. If it reports a bug, find the root cause and fix it with tests. Otherwise do what it asks, with tests where they apply. Summarize what you changed.`;

export const PROMPT_PLACEHOLDERS = ["number", "title", "url", "repo"] as const;

export function renderPrompt(template: string, values: Record<(typeof PROMPT_PLACEHOLDERS)[number], string>) {
  return template.replace(/\{(number|title|url|repo)\}/g, (_match, key: keyof typeof values) => values[key]);
}

/** `selectedRepo` when the All tab is picked; no `owner/repo` looks like it. */
export const ALL_TAB = "*";

/** Most owners the All tab searches at once, which keeps the search query short. */
export const MAX_OWNERS = 20;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** GitHub logins from text separated by commas or spaces, deduplicated; null when one is not a login. */
export function parseOwners(text: string): string[] | null {
  const words = text.split(/[\s,]+/).filter(Boolean);
  if (words.length > MAX_OWNERS || words.some((w) => !OWNER.test(w))) return null;
  return words.filter((w, i) => words.findIndex((o) => o.toLowerCase() === w.toLowerCase()) === i);
}

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    /** New branches are named `<prefix><number>-<slug>`. */
    branchPrefix: z.string().default("issue/"),
    /** Lowercased `owner/repo` of the project picked at the top of the screen; empty picks the first. */
    selectedRepo: z.string().default(""),
    /** The last search, in GitHub's issue search syntax. */
    searchQuery: z.string().default(DEFAULT_QUERY),
    density: z.enum(DENSITIES).default("comfortable"),
    sort: z.enum(SORTS).default("created-desc"),
    /** `provider/model` for "Create and start". Empty uses the first ready provider and its default model. */
    agent: z.string().default(""),
    /** Thinking option id (`low`, `high`, ...) for "Create and start". Empty, or one the model lacks, uses the model's default. */
    effort: z.string().default(""),
    /** The first message "Create and start" sends the agent. */
    agentPrompt: z.string().default(DEFAULT_AGENT_PROMPT),
    /** GitHub organizations or users whose open issues the All tab searches; empty hides the tab. */
    owners: z.array(z.string()).default([]),
  }),
});
export type Preferences = z.infer<typeof preferences.schema>;
export const DEFAULT_PREFERENCES: Preferences = preferences.schema.parse({});

export function branchPrefixError(prefix: string): string | null {
  if (!prefix) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(prefix)) {
    return "Use letters, digits, '.', '_', '-' and '/', starting with a letter or digit";
  }
  if (prefix.includes("..") || prefix.includes("//") || prefix.includes("/.")) {
    return "Cannot contain '..', '//' or '/.'";
  }
  return null;
}

/** The prompt to use: the saved one, or the default when it is empty. */
export function effectiveAgentPrompt(saved: string): string {
  return saved.trim() ? saved : DEFAULT_AGENT_PROMPT;
}

/** Settings that fail validation fall back to defaults rather than breaking the screen. */
export function effectivePreferences(values: Preferences): Preferences {
  return {
    branchPrefix: branchPrefixError(values.branchPrefix) ? DEFAULT_PREFERENCES.branchPrefix : values.branchPrefix,
    selectedRepo: values.selectedRepo,
    searchQuery: values.searchQuery,
    density: values.density,
    sort: values.sort,
    agent: values.agent,
    effort: values.effort,
    agentPrompt: effectiveAgentPrompt(values.agentPrompt),
    owners: values.owners.filter((o) => OWNER.test(o)).slice(0, MAX_OWNERS),
  };
}

/** `owner/repo` from a Paseo project key such as `remote:github.com/owner/repo`, else null. */
export function parseProjectKey(key: string | null | undefined): string | null {
  const m = key?.match(/^remote:github\.com\/([^/\s]+\/[^/\s]+)$/i);
  return m ? m[1] : null;
}

const SLUG_LENGTH = 40;

/** `<prefix><n>-<slug>`, the slug cut at a word boundary to at most 40 characters. */
export function branchName(prefix: string, n: number, title: string): string {
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let slug = words.slice(0, SLUG_LENGTH);
  if (words.length > SLUG_LENGTH && words[SLUG_LENGTH] !== "-" && slug.includes("-")) {
    slug = slug.slice(0, slug.lastIndexOf("-"));
  }
  slug = slug.replace(/-+$/, "");
  return slug ? `${prefix}${n}-${slug}` : `${prefix}${n}`;
}

/** The parts of a provider snapshot entry that choosing an agent needs. */
export type ProviderEntry = {
  provider: string;
  status: string;
  enabled?: boolean;
  models?: {
    id: string;
    isDefault?: boolean;
    isSelectable?: boolean;
    thinkingOptions?: { id: string; label: string; isDefault?: boolean }[];
    defaultThinkingOptionId?: string;
  }[];
};

/** The first ready provider with its default model, as `provider/model`; null when none is ready. */
export function defaultAgent(entries: readonly ProviderEntry[]): string | null {
  for (const p of entries) {
    if (p.enabled === false || p.status !== "ready") continue;
    const models = (p.models ?? []).filter((m) => m.isSelectable !== false);
    const model = models.find((m) => m.isDefault) ?? models[0];
    if (model) return `${p.provider}/${model.id}`;
  }
  return null;
}

/** The model `agent` (`provider/model`) names, when a ready provider in `entries` offers it. */
function findModel(entries: readonly ProviderEntry[], agent: string) {
  const at = agent.indexOf("/");
  const provider = agent.slice(0, at);
  const model = agent.slice(at + 1);
  return entries
    .find((p) => p.provider === provider && p.enabled !== false && p.status === "ready")
    ?.models?.find((m) => m.id === model && m.isSelectable !== false);
}

/** Whether `agent` (`provider/model`) is offered by a ready provider in `entries`. */
export function agentAvailable(entries: readonly ProviderEntry[], agent: string): boolean {
  return findModel(entries, agent) !== undefined;
}

/** The effort levels `agent`'s model offers, and the one it uses by default. */
export function effortChoices(entries: readonly ProviderEntry[], agent: string) {
  const model = findModel(entries, agent);
  const options = model?.thinkingOptions ?? [];
  const defaultId = model?.defaultThinkingOptionId ?? options.find((o) => o.isDefault)?.id ?? null;
  return { options: options.map(({ id, label }) => ({ id, label })), defaultId };
}

/** `effort` when `agent`'s model offers it, else null so the model's default applies. */
export function offeredEffort(entries: readonly ProviderEntry[], agent: string, effort: string): string | null {
  return effort && effortChoices(entries, agent).options.some((o) => o.id === effort) ? effort : null;
}

/** `owner/repo` for a github.com remote URL, else null. */
export function parseGitHubRemote(url: string): string | null {
  const m = url
    .trim()
    .match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?github\.com(?::\d+)?[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A workspace covers issue `n` when its title starts with `#n`, or its branch is
 * `<prefix>n-…` or contains `n-` right after a slash.
 */
export function issueMatcher(n: number, branchPrefix: string) {
  const titleRe = new RegExp(`^#${n}\\b`);
  const branchRes = [new RegExp(`(^|/)${n}-`), new RegExp(`^${escapeRegExp(branchPrefix)}${n}-`)];
  return {
    title: (title: string) => titleRe.test(title),
    branch: (branch: string) => branchRes.some((re) => re.test(branch)),
  };
}

const issue = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  /** `color` is GitHub's hex value without the leading `#`. */
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  /** Login of whoever opened the issue; apps appear without their `app/` prefix. */
  author: z.string().nullable(),
  createdAt: z.string(),
  /** The workspace in this project that already covers this issue, if one does. */
  workspace: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** A local branch for this issue with no active workspace (e.g. the workspace was archived). */
  orphanBranch: z.string().nullable(),
  /** `owner/repo` the issue is in. Set in the All tab, whose issues span repositories. */
  repo: z.string().optional(),
  /** In the All tab, this host's project on the issue's repository; null when there is none. */
  projectId: z.string().nullable().optional(),
});
export type Issue = z.infer<typeof issue>;

const pullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  reviewDecision: z.string().nullable(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  isInMergeQueue: z.boolean(),
});
export type PullRequest = z.infer<typeof pullRequest>;

const repoSlug = z.string().regex(/^[^/\s]+\/[^/\s]+$/);

/**
 * GitHub's closing PR links for the visible issues, fetched independently of the issue search.
 * `repo` and `numbers` answer by issue number; `issues`, for the All tab's page across
 * repositories, answers by `owner/repo#number` and leaves out repositories GitHub refuses.
 */
export const pullRequestsRpc = defineRpc({
  name: "issues.pull-requests",
  input: z.union([
    z.object({
      repo: repoSlug,
      numbers: z.array(z.number().int().positive()).max(PAGE_SIZE),
    }),
    z.object({
      issues: z.array(z.object({ repo: repoSlug, number: z.number().int().positive() })).max(PAGE_SIZE),
    }),
  ]),
  output: z.object({ pullRequests: z.record(z.string(), z.array(pullRequest)) }),
});

/** A GitHub repository behind one or more of this host's projects. */
const repoProject = z.object({
  /** The project new workspaces go to: a main checkout rather than a linked worktree. */
  projectId: z.string(),
  projectName: z.string(),
  /** `owner/repo` on github.com. */
  repo: z.string(),
  /** Other projects on the same repository, such as linked worktrees. */
  otherProjects: z.array(z.string()),
  /** The icon Paseo shows for the project, base64; null when it has none. */
  icon: z.object({ data: z.string(), mimeType: z.string() }).nullable(),
});
export type RepoProject = z.infer<typeof repoProject>;

/** This host's GitHub projects, for the project picker. Makes no GitHub calls. */
export const projectsRpc = defineRpc({
  name: "issues.projects",
  input: z.object({}),
  output: z.object({
    repos: z.array(repoProject),
    /** Git projects without a github.com remote. */
    skipped: z.array(z.object({ projectName: z.string(), reason: z.string() })),
  }),
});

const owners = z.array(z.string().regex(OWNER)).min(1).max(MAX_OWNERS);

/** One page of open issues in one repository, or across owners for the All tab, in the chosen order. */
export const issuesPageRpc = defineRpc({
  name: "issues.page",
  /**
   * `projectId` for this host's projects; `repo` for a repository only another host has; `owners`
   * for every repository of those GitHub organizations and users.
   */
  input: z
    .object({
      projectId: z.string().optional(),
      repo: z.string().optional(),
      owners: owners.optional(),
      /** GitHub's issue search syntax; `is:issue state:open` is implied. */
      query: z.string().max(1000),
      page: z.number().int().min(1),
      sort: z.enum(SORTS).default("created-desc"),
    })
    .refine(
      (v) => [v.projectId, v.repo, v.owners].filter(Boolean).length === 1,
      "Pass exactly one of projectId, repo and owners",
    ),
  output: z.object({ issues: z.array(issue), totalCount: z.number() }),
});

const named = z.object({ name: z.string(), color: z.string(), description: z.string().nullable() });

/**
 * What the filter menus offer for one repository. For `owners` only the signed-in user and the
 * organizations' issue types are known; the screen takes labels from the issues it shows.
 */
export const filterOptionsRpc = defineRpc({
  name: "issues.filter-options",
  input: z.union([z.object({ repo: repoSlug }), z.object({ owners })]),
  output: z.object({
    /** The signed-in GitHub login, which `@me` stands for. */
    me: z.string().nullable(),
    labels: z.array(named),
    milestones: z.array(z.object({ title: z.string(), description: z.string().nullable() })),
    /** People who can be assigned, which GitHub also suggests as authors. */
    users: z.array(z.object({ login: z.string(), avatarUrl: z.string().nullable() })),
    /** Organization issue types; `color` is a GitHub color name such as RED. */
    types: z.array(named),
  }),
});

/**
 * Open issues assigned to me per repository, for the project tabs, and across `owners` under
 * `ALL_TAB` for the All tab; repositories GitHub refuses are left out.
 */
export const assignedCountsRpc = defineRpc({
  name: "issues.assigned-counts",
  input: z.object({ repos: z.array(z.string()).max(50), owners: owners.optional() }),
  output: z.object({ counts: z.record(z.string(), z.number()) }),
});

/** What creating a workspace on another host needs from GitHub. */
export const issueDetailsRpc = defineRpc({
  name: "issues.details",
  input: z.object({ repo: z.string(), number: z.number() }),
  output: z.object({ title: z.string(), state: z.string(), url: z.string(), defaultBranch: z.string() }),
});

/** `create` makes the workspace only; `agent` also starts an agent with the agent prompt. */
export const CREATE_ACTIONS = ["create", "agent"] as const;
export type CreateAction = (typeof CREATE_ACTIONS)[number];

export const createWorkspaceRpc = defineRpc({
  name: "issues.create-workspace",
  input: z.object({ projectId: z.string(), number: z.number(), action: z.enum(CREATE_ACTIONS) }),
  output: z.object({
    workspaceId: z.string(),
    branch: z.string(),
    /** Set for `agent`. */
    agentId: z.string().nullable(),
    /** The `provider/model` the agent runs, for `agent`. */
    agent: z.string().nullable(),
    /** The effort the agent starts with, for `agent`; null when it uses the model's default. */
    effort: z.string().nullable(),
  }),
});
