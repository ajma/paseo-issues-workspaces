import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, preferences } from "../shared/issues";

// The entry wires settings into the handlers; the handlers themselves are tested in issues.test.ts.
const projectList = vi.fn(async (..._args: unknown[]) => ({ ok: "projects" }));
const filterOptions = vi.fn(async (..._args: unknown[]) => ({ ok: "options" }));
const issueDetails = vi.fn(async (..._args: unknown[]) => ({ ok: "details" }));
const pullRequests = vi.fn(async (..._args: unknown[]) => ({ pullRequests: {} }));
const issuesPage = vi.fn(async (..._args: unknown[]) => ({ ok: "page" }));
const createWorkspace = vi.fn(async (..._args: unknown[]) => ({ ok: "create" }));
vi.mock("./issues", () => ({ projectList, issuesPage, filterOptions, issueDetails, createWorkspace, pullRequests }));

const { default: contribute } = await import("../index.server");

function fakeServer(state: unknown) {
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const registered: unknown[] = [];
  const server = {
    registerSettings: (definition: unknown) => {
      registered.push(definition);
      return { read: async () => state, subscribe: () => () => {} };
    },
    handle: (contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) => {
      handlers.set(contract.name, handler);
    },
  };
  return { server: server as any, handlers, registered };
}

const paseo = { marker: "paseo" };

beforeEach(() => {
  projectList.mockClear();
  issuesPage.mockClear();
  createWorkspace.mockClear();
});

describe("index.server", () => {
  it("registers the preferences document and every RPC", () => {
    const { server, handlers, registered } = fakeServer({ status: "ready", revision: "1", values: DEFAULT_PREFERENCES });
    contribute(server);
    expect(registered).toEqual([preferences]);
    expect([...handlers.keys()].sort()).toEqual([
      "issues.assigned-counts",
      "issues.create-workspace",
      "issues.details",
      "issues.filter-options",
      "issues.page",
      "issues.projects",
      "issues.pull-requests",
    ]);
  });

  it("lists projects without settings, and passes filter and details requests through", async () => {
    const { server, handlers } = fakeServer({ status: "ready", revision: "1", values: DEFAULT_PREFERENCES });
    contribute(server);

    await handlers.get("issues.projects")!({}, { paseo });
    await handlers.get("issues.filter-options")!({ repo: "o/r" }, { paseo });
    await handlers.get("issues.details")!({ repo: "o/r", number: 3 }, { paseo });
    await handlers.get("issues.pull-requests")!({ repo: "o/r", numbers: [3] }, { paseo });

    expect(projectList).toHaveBeenCalledWith(paseo);
    expect(filterOptions).toHaveBeenCalledWith({ repo: "o/r" });
    expect(issueDetails).toHaveBeenCalledWith({ repo: "o/r", number: 3 });
    expect(pullRequests).toHaveBeenCalledWith({ repo: "o/r", numbers: [3] });
  });

  it("hands a page request to issuesPage", async () => {
    const { server, handlers } = fakeServer({ status: "ready", revision: "1", values: DEFAULT_PREFERENCES });
    contribute(server);

    await handlers.get("issues.page")!({ projectId: "p", query: "label:bug", page: 2 }, { paseo });

    expect(issuesPage).toHaveBeenCalledWith(paseo, DEFAULT_PREFERENCES, { projectId: "p", query: "label:bug", page: 2 });
  });

  it("repairs invalid fields before using them", async () => {
    const values = { ...DEFAULT_PREFERENCES, branchPrefix: "-x", agentPrompt: " " };
    const { server, handlers } = fakeServer({ status: "ready", revision: "1", values });
    contribute(server);

    await handlers.get("issues.create-workspace")!({ projectId: "p", number: 1, action: "agent" }, { paseo });

    expect(createWorkspace).toHaveBeenCalledWith(
      paseo,
      expect.objectContaining({ branchPrefix: "issue/", agentPrompt: DEFAULT_PREFERENCES.agentPrompt }),
      { projectId: "p", number: 1, action: "agent" },
    );
  });

  it("uses defaults when the stored document cannot be read", async () => {
    const { server, handlers } = fakeServer({ status: "invalid", revision: "1", error: "bad json" });
    contribute(server);

    await handlers.get("issues.page")!({ repo: "o/r", query: "", page: 1 }, { paseo });

    expect(issuesPage).toHaveBeenCalledWith(paseo, DEFAULT_PREFERENCES, { repo: "o/r", query: "", page: 1 });
  });
});
