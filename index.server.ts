import type { PluginServerContext } from "@getpaseo/plugin/server";
import { assignedCounts, createWorkspace, filterOptions, issueDetails, issuesPage, projectList, pullRequests } from "./server/issues";
import {
  assignedCountsRpc,
  createWorkspaceRpc,
  DEFAULT_PREFERENCES,
  effectivePreferences,
  filterOptionsRpc,
  issueDetailsRpc,
  issuesPageRpc,
  preferences,
  projectsRpc,
  pullRequestsRpc,
} from "./shared/issues";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const readPreferences = async () => {
    const state = await settings.read();
    return state.status === "ready" ? effectivePreferences(state.values) : DEFAULT_PREFERENCES;
  };

  server.handle(projectsRpc, (_input, { paseo }) => projectList(paseo));
  server.handle(issuesPageRpc, async (input, { paseo }) => issuesPage(paseo, await readPreferences(), input));
  server.handle(filterOptionsRpc, (input) => filterOptions(input));
  server.handle(assignedCountsRpc, (input) => assignedCounts(input));
  server.handle(pullRequestsRpc, (input) => pullRequests(input));
  server.handle(issueDetailsRpc, (input) => issueDetails(input));
  server.handle(createWorkspaceRpc, async (input, { paseo }) =>
    createWorkspace(paseo, await readPreferences(), input),
  );
  return () => {};
}
