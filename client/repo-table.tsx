import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { issuesPageRpc, pageCountFor, pullRequestsRpc, type CreateAction, type Density, type Issue } from "../shared/issues";
import { isDarkTheme, openIssueColor } from "./github-style";
import { findRemoteWorkspaces, withRemoteCoverage, type ProjectOption, type RemoteWorkspace } from "./issue-list";
import { IssueRow } from "./issue-row";
import { Pager } from "./pager";
import { PR_COLUMN_WIDTH, WORKSPACE_COLUMN_WIDTH } from "./pull-request-status";

export const PAGE_QUERY_KEY = ["issues.page"];
export const PULL_REQUESTS_QUERY_KEY = ["issues.pull-requests"];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const formatCount = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * The selected project's issues as a GitHub-style table with a pager. Each page is fetched
 * from GitHub when it is shown.
 */
export function RepoTable({
  project,
  query,
  page,
  onPageChange,
  density,
  branchPrefix,
  otherHostWorkspaces,
  pendingNumber,
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
  project: ProjectOption;
  query: string;
  page: number;
  onPageChange: (page: number) => void;
  density: Density;
  branchPrefix: string;
  /** Every other host's workspaces: links for this host's issues, coverage for another host's project. */
  otherHostWorkspaces: RemoteWorkspace[] | undefined;
  /** The issue number being created, if any. */
  pendingNumber: number | null;
  busy: boolean;
  onCreate: (issue: Issue, action: CreateAction) => void;
  agentLabel: string;
  /** Filters and density, shown at the right of the header as on github.com. */
  headerControls?: ReactNode;
  /** A header menu is open: the rows are covered so pressing them closes it. */
  menuOpen?: boolean;
  onDismissMenu?: () => void;
  /** The issue whose create menu is open. */
  createMenuFor?: number | null;
  onCreateMenu?: (issue: number | null) => void;
  pullRequestsFor?: number | null;
  onPullRequestsMenu?: (issue: number | null) => void;
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
    queryKey: [...PAGE_QUERY_KEY, project.key, query, page],
    queryFn: () =>
      fetchPage(project.remote ? { repo: project.repo, query, page } : { projectId: project.projectId, query, page }),
    // Keep the previous page on screen, dimmed, until the next one arrives.
    placeholderData: keepPreviousData,
    // GitHub allows 30 searches a minute; revisiting a page shouldn't spend one. Refresh still does.
    staleTime: 60_000,
  });

  const remote = project.remote;
  const raw = result.data?.issues ?? [];
  const fetchPullRequests = useRpc(pullRequestsRpc);
  const numbers = raw.map((issue) => issue.number);
  const prs = useQuery({
    queryKey: [...PULL_REQUESTS_QUERY_KEY, project.repo, numbers],
    queryFn: () => fetchPullRequests({ repo: project.repo, numbers }),
    enabled: numbers.length > 0 && !result.isPlaceholderData && result.isSuccess,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  // Another host's project is covered by that host's workspaces; the server only knows this host's.
  const issues = remote
    ? withRemoteCoverage(raw, otherHostWorkspaces, remote.serverId, project.repo, branchPrefix)
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
          {headerControls}
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
              key={issue.number}
              issue={issue}
              pullRequests={stale ? undefined : prs.data?.pullRequests[issue.number]}
              density={density}
              elsewhere={
                remote || issue.workspace
                  ? []
                  : findRemoteWorkspaces(otherHostWorkspaces, project.repo, issue.number, branchPrefix)
              }
              first={index === 0}
              pending={pendingNumber === issue.number}
              busy={busy}
              onCreate={(action) => onCreate(issue, action)}
              agentLabel={agentLabel}
              workspaceServerId={remote?.serverId}
              menuOpen={createMenuFor === issue.number}
              onMenuOpenChange={(open) => onCreateMenu?.(open ? issue.number : null)}
              pullRequestsOpen={!stale && pullRequestsFor === issue.number}
              onPullRequestsOpenChange={(open) => onPullRequestsMenu?.(open ? issue.number : null)}
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
