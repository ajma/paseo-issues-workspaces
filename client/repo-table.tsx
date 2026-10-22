import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  issuesPageRpc,
  pageCountFor,
  pullRequestsRpc,
  type CreateAction,
  type Density,
  type Issue,
  type PullRequest,
  type Sort,
} from "../shared/issues";
import { isDarkTheme, openIssueColor } from "./github-style";
import { findRemoteWorkspaces, withRemoteCoverage, type ProjectOption, type RemoteWorkspace } from "./issue-list";
import { IssueRow } from "./issue-row";
import { Pager } from "./pager";
import { PR_COLUMN_WIDTH, WORKSPACE_COLUMN_WIDTH } from "./pull-request-status";

export const PAGE_QUERY_KEY = ["issues.page"];
export const PULL_REQUESTS_QUERY_KEY = ["issues.pull-requests"];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const formatCount = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** An issue's identity across repositories; numbers repeat in the All tab. */
const issueKey = (issue: Issue) => issue.url;

/**
 * The selected project's issues, or the All tab's issues across `owners`, as a GitHub-style table
 * with a pager. Each page is fetched from GitHub when it is shown.
 */
export function RepoTable({
  project,
  owners,
  query,
  sort,
  page,
  onPageChange,
  density,
  branchPrefix,
  otherHostWorkspaces,
  pendingKey,
  busy,
  onCreate,
  agentLabel,
  headerControls,
  menuOpen = false,
  onDismissMenu,
  createMenuFor = null,
  onCreateMenu,
  pullRequestsFor = null,
  onPullRequestsMenu,
  theme,
  layout,
  navigation,
}: Pick<PluginScreenProps, "theme" | "layout" | "navigation"> & {
  /** The project shown; unused when `owners` is set. */
  project?: ProjectOption;
  /** GitHub owners whose issues the All tab shows. */
  owners?: string[];
  query: string;
  sort: Sort;
  page: number;
  onPageChange: (page: number) => void;
  density: Density;
  branchPrefix: string;
  /** Every other host's workspaces: links for this host's issues, coverage for another host's project. */
  otherHostWorkspaces: RemoteWorkspace[] | undefined;
  /** The URL of the issue being created, if any. */
  pendingKey: string | null;
  busy: boolean;
  onCreate: (issue: Issue, action: CreateAction) => void;
  agentLabel: string;
  /** Filters and density for the issues shown, at the right of the header as on github.com. */
  headerControls?: (issues: Issue[]) => ReactNode;
  /** A header menu is open: the rows are covered so pressing them closes it. */
  menuOpen?: boolean;
  onDismissMenu?: () => void;
  /** The URL of the issue whose create menu is open. */
  createMenuFor?: string | null;
  onCreateMenu?: (issue: string | null) => void;
  pullRequestsFor?: string | null;
  onPullRequestsMenu?: (issue: string | null) => void;
}) {
  const [tableWidth, setTableWidth] = useState(0);
  const rowLayout = { ...layout, compact: layout.compact || (tableWidth > 0 && tableWidth < 840) };
  const rowMenuOpen = createMenuFor !== null || pullRequestsFor !== null;
  const dismissRowMenu = () => {
    onCreateMenu?.(null);
    onPullRequestsMenu?.(null);
  };
  const fetchPage = useRpc(issuesPageRpc);
  const result = useQuery({
    queryKey: [...PAGE_QUERY_KEY, owners ? `owners:${owners.join(",")}` : project?.key, query, sort, page],
    queryFn: () =>
      fetchPage(
        owners
          ? { owners, query, page, sort }
          : project!.remote
            ? { repo: project!.repo, query, page, sort }
            : { projectId: project!.projectId, query, page, sort },
      ),
    // Keep the previous page on screen, dimmed, until the next one arrives.
    placeholderData: keepPreviousData,
    // GitHub allows 30 searches a minute; revisiting a page shouldn't spend one. Refresh still does.
    staleTime: 60_000,
  });

  const remote = owners ? undefined : project?.remote;
  const raw = result.data?.issues ?? [];
  const repoOf = (issue: Issue) => issue.repo ?? project?.repo ?? "";
  const fetchPullRequests = useRpc(pullRequestsRpc);
  const prs = useQuery({
    queryKey: [...PULL_REQUESTS_QUERY_KEY, raw.map((issue) => `${repoOf(issue)}#${issue.number}`)],
    queryFn: async (): Promise<Record<string, PullRequest[]>> => {
      // The All tab's page spans repositories: one request for all of them, keyed `owner/repo#number`.
      if (owners) {
        const issues = raw.map((issue) => ({ repo: repoOf(issue), number: issue.number }));
        return (await fetchPullRequests({ issues })).pullRequests;
      }
      const repo = project!.repo;
      const { pullRequests } = await fetchPullRequests({ repo, numbers: raw.map((issue) => issue.number) });
      return Object.fromEntries(Object.entries(pullRequests).map(([n, list]) => [`${repo}#${n}`, list]));
    },
    enabled: raw.length > 0 && !result.isPlaceholderData && result.isSuccess,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  // Another host's project is covered by that host's workspaces; the server only knows this host's.
  const issues = remote
    ? withRemoteCoverage(raw, otherHostWorkspaces, remote.serverId, project!.repo, branchPrefix)
    : raw;
  const totalCount = result.data?.totalCount ?? 0;
  const stale = result.isPlaceholderData;
  const dark = isDarkTheme(theme);

  const s = useMemo(
    () => ({
      // No overflow clipping: the header's filter dropdowns hang below it, over the rows.
      box: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        backgroundColor: theme.colors.surface0,
      },
      header: {
        flexDirection: (layout.compact ? "column" : "row") as "column" | "row",
        alignItems: (layout.compact ? "stretch" : "center") as "stretch" | "center",
        justifyContent: "space-between" as const,
        gap: 8,
        paddingVertical: 8,
        paddingHorizontal: layout.compact ? 12 : 16,
        backgroundColor: theme.colors.surface1,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        borderTopLeftRadius: 6,
        borderTopRightRadius: 6,
        zIndex: 10,
      },
      summary: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      repo: { color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "400" as const },
      count: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      error: { color: theme.colors.statusDanger, paddingVertical: 12, paddingHorizontal: 16 },
      empty: { color: theme.colors.foregroundMuted, paddingVertical: 24, textAlign: "center" as const },
      loading: { paddingVertical: 24 },
    }),
    [theme, layout.compact],
  );

  return (
    <View style={{ gap: 12 }}>
      {/* Above the pager while a row's menu is open, so a dropdown on the last row stays on top. */}
      <View onLayout={(event) => setTableWidth(event.nativeEvent.layout.width)} style={[s.box, rowMenuOpen ? { zIndex: 1 } : null]}>
        <View style={s.header}>
          <View style={s.summary}>
            <Icon name="CircleDot" size={16} color={openIssueColor(dark)} />
            <Text style={s.count}>{formatCount(totalCount)} Open</Text>
            {remote ? <Text style={s.repo}>on {remote.hostLabel}</Text> : null}
            {result.isFetching && result.data ? (
              <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            ) : null}
          </View>
          {headerControls?.(raw)}
        </View>
        {!rowLayout.compact ? (
          <View style={{ flexDirection: "row", gap: 8, paddingLeft: 40, paddingRight: 16, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
            <Text style={[s.repo, { flex: 1, marginRight: 8 }]}>Issue</Text>
            <Text style={[s.repo, { width: PR_COLUMN_WIDTH }]}>Pull requests</Text>
            <Text style={[s.repo, { width: WORKSPACE_COLUMN_WIDTH }]}>Workspace</Text>
          </View>
        ) : null}
        {menuOpen ? (
          // Above the rows, below the header and its dropdown.
          <Pressable
            accessibilityLabel="Close filter menu"
            onPress={onDismissMenu}
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 5 }}
          />
        ) : null}
        {result.isError ? <Text style={s.error}>Could not load issues: {message(result.error)}</Text> : null}
        {raw.length > 0 && !stale && prs.isError ? (
          <Text style={s.error}>Could not load PR status: {message(prs.error)}. Use Refresh issues to retry.</Text>
        ) : null}
        {prs.isFetching ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, padding: 8 }}>Updating PR status…</Text>
        ) : null}
        {result.isPending ? (
          <View style={s.loading}>
            <ActivityIndicator color={theme.colors.foregroundMuted} />
          </View>
        ) : null}
        {result.isSuccess && !raw.length ? <Text style={s.empty}>No results matched your search.</Text> : null}
        <View style={[stale ? { opacity: 0.5 } : null, rowMenuOpen ? { zIndex: 6 } : null]}>
          {rowMenuOpen ? (
            // Covers the rows, under the row whose menu is open.
            <Pressable
              accessibilityLabel={pullRequestsFor !== null ? "Dismiss pull requests" : "Close menu"}
              onPress={dismissRowMenu}
              style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 5 }}
            />
          ) : null}
          {issues.map((issue, index) => (
            <IssueRow
              key={issueKey(issue)}
              issue={issue}
              showRepo={Boolean(owners)}
              pullRequests={stale ? undefined : prs.data?.[`${repoOf(issue)}#${issue.number}`]}
              density={density}
              elsewhere={
                remote || issue.workspace
                  ? []
                  : findRemoteWorkspaces(otherHostWorkspaces, repoOf(issue), issue.number, branchPrefix)
              }
              first={index === 0}
              pending={pendingKey === issueKey(issue)}
              busy={busy}
              // In the All tab, only an issue whose repository is one of this host's projects can get a workspace.
              onCreate={owners && !issue.projectId ? undefined : (action) => onCreate(issue, action)}
              agentLabel={agentLabel}
              workspaceServerId={remote?.serverId}
              menuOpen={createMenuFor === issueKey(issue)}
              onMenuOpenChange={(open) => onCreateMenu?.(open ? issueKey(issue) : null)}
              pullRequestsOpen={!stale && pullRequestsFor === issueKey(issue)}
              onPullRequestsOpenChange={(open) => onPullRequestsMenu?.(open ? issueKey(issue) : null)}
              theme={theme}
              layout={rowLayout}
              navigation={navigation}
            />
          ))}
        </View>
      </View>
      <Pager
        page={page}
        pageCount={pageCountFor(totalCount)}
        onChange={onPageChange}
        compact={layout.compact}
        theme={theme}
      />
    </View>
  );
}
