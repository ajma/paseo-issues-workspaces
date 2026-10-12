import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { getPaseoClient, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View, type ScrollView as NativeScrollView } from "react-native";
import {
  assignedCountsRpc,
  createWorkspaceRpc,
  DEFAULT_PREFERENCES,
  DEFAULT_QUERY,
  effectivePreferences,
  issueDetailsRpc,
  preferences,
  projectsRpc,
  type CreateAction,
  type Density,
  type Issue,
  type Preferences,
} from "../shared/issues";
import { FilterControls, type MenuId } from "./filter-bar";
import { pickProject, remoteOnlyProjects, showProjectSelector, type ProjectOption } from "./issue-list";
import { OTHER_HOSTS_QUERY_KEY, useOtherHosts } from "./other-hosts";
import { ProjectSelector } from "./project-selector";
import { createOnHost } from "./remote-create";
import { PAGE_QUERY_KEY, PULL_REQUESTS_QUERY_KEY, RepoTable } from "./repo-table";
import { SearchBar } from "./search-bar";

const PROJECTS_QUERY_KEY = ["issues.projects"];
const COUNTS_QUERY_KEY = ["issues.assigned-counts"];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function IssuesScreen({
  theme,
  layout,
  navigation,
  host,
  onOpenSettings,
}: PluginScreenProps & {
  /** Opens the plugin's settings page; screens can't, so the client entry passes this in. */
  onOpenSettings?: () => void;
}) {
  const listProjects = useRpc(projectsRpc);
  const fetchCounts = useRpc(assignedCountsRpc);
  const issueDetails = useRpc(issueDetailsRpc);
  const createWorkspace = useRpc(createWorkspaceRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState<number | null>(null);
  // One menu at a time: filters, workspace creation, or an issue's PRs.
  const [openMenu, setFilterMenu] = useState<MenuId | null>(null);
  const [createMenu, setCreateMenu] = useState<number | null>(null);
  const [pullRequestsMenu, setPullRequestsMenu] = useState<number | null>(null);
  const setOpenMenu = (menu: MenuId | null) => {
    setFilterMenu(menu);
    setCreateMenu(null);
    setPullRequestsMenu(null);
  };
  const openCreateMenu = (issue: number | null) => {
    setFilterMenu(null);
    setCreateMenu(issue);
    setPullRequestsMenu(null);
  };
  const openPullRequestsMenu = (issue: number | null) => {
    setFilterMenu(null);
    setCreateMenu(null);
    setPullRequestsMenu(issue);
  };
  const [page, setPage] = useState(1);
  const scroller = useRef<NativeScrollView>(null);

  const settings = useSettings(preferences);
  const saved = settings.status === "ready" ? settings.values : null;
  // Local choices apply at once; saved values carry them across sessions and clients.
  const [queryChoice, setQueryChoice] = useState<string | null>(null);
  const [densityChoice, setDensityChoice] = useState<Density | null>(null);
  const [repoChoice, setRepoChoice] = useState<string | null>(null);
  const query = queryChoice ?? saved?.searchQuery ?? DEFAULT_QUERY;
  const density = densityChoice ?? saved?.density ?? "comfortable";
  const prefs = effectivePreferences(saved ?? DEFAULT_PREFERENCES);

  const projects = useQuery({ queryKey: PROJECTS_QUERY_KEY, queryFn: () => listProjects({}) });
  const others = useOtherHosts(host.id);
  const options: ProjectOption[] = projects.data
    ? [
        ...projects.data.repos.map((r) => ({ ...r, key: r.projectId })),
        ...remoteOnlyProjects(
          projects.data.repos.map((r) => r.repo),
          others.data?.projects ?? [],
        ).map((p) => ({
          key: `${p.serverId}/${p.projectId}`,
          projectId: p.projectId,
          projectName: p.name,
          repo: p.repo,
          otherProjects: [],
          remote: p,
        })),
      ]
    : [];
  const selected = pickProject(options, repoChoice ?? saved?.selectedRepo ?? "");
  const showTabs = showProjectSelector(options);
  // Assigned-to-me counts for the tabs arrive separately, so they never hold up the page.
  const tabRepos = options.map((o) => o.repo);
  const counts = useQuery({
    queryKey: [...COUNTS_QUERY_KEY, tabRepos.join(",")],
    queryFn: () => fetchCounts({ repos: tabRepos }),
    enabled: showTabs,
    staleTime: 5 * 60_000,
  });

  async function savePreferences(patch: Partial<Preferences>) {
    if (settings.status !== "ready") return false;
    return settings.save({ ...settings.values, ...patch }, settings.revision);
  }
  function search(next: string) {
    setPullRequestsMenu(null);
    setCreateMenu(null);
    setQueryChoice(next);
    setPage(1);
    void savePreferences({ searchQuery: next });
  }
  function selectProject(option: ProjectOption) {
    setRepoChoice(option.repo.toLowerCase());
    setPage(1);
    setOpenMenu(null);
    void savePreferences({ selectedRepo: option.repo.toLowerCase() });
  }

  const create = useMutation({
    mutationFn: async ({ project, issue, action }: { project: ProjectOption; issue: Issue; action: CreateAction }) => {
      if (!project.remote) return createWorkspace({ projectId: project.projectId, number: issue.number, action });
      const details = await issueDetails({ repo: project.repo, number: issue.number });
      return createOnHost({
        paseo: getPaseoClient(project.remote.serverId),
        project: project.remote,
        number: issue.number,
        details,
        action,
        prefs,
      });
    },
    onMutate: ({ issue }) => setPending(issue.number),
    onSuccess: (result, { project, issue }) => {
      const where = project.remote ? ` on ${project.remote.hostLabel}` : "";
      toast.show(
        result.agent
          ? `Created workspace for #${issue.number}${where} and started ${result.agent}`
          : `Created workspace for #${issue.number}${where}`,
        { variant: "success" },
      );
    },
    onError: (error, { issue }) => {
      toast.show(`#${issue.number}: ${message(error)}`, { variant: "error" });
    },
    onSettled: () => {
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: PAGE_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: OTHER_HOSTS_QUERY_KEY });
    },
  });

  const s = useMemo(() => {
    const pad = layout.compact ? 16 : 24;
    return {
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: pad, gap: 12 },
      searchRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger },
      iconButton: { padding: 8, borderRadius: 6 },
      // Closes an open filter menu when anything outside it is pressed.
      backdrop: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0, zIndex: 5 },
    };
  }, [theme, layout.compact]);

  const refreshing = projects.isFetching || others.isFetching;

  return (
    <ScrollView ref={scroller} style={s.screen} contentContainerStyle={s.content}>
      {openMenu || createMenu !== null || pullRequestsMenu !== null ? (
        <Pressable
          accessibilityLabel={openMenu ? "Close filter menu" : pullRequestsMenu !== null ? "Dismiss pull requests" : "Close menu"}
          onPress={() => setOpenMenu(null)}
          style={s.backdrop}
        />
      ) : null}
      {showTabs ? (
        <ProjectSelector
          options={options}
          counts={counts.data?.counts}
          selectedKey={selected?.key ?? null}
          onSelect={selectProject}
          theme={theme}
          layout={layout}
        />
      ) : null}

      <View style={s.searchRow}>
        <View style={{ flex: 1 }}>
          <SearchBar query={query} onSearch={search} theme={theme} />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh issues"
          disabled={refreshing}
          onPress={() => {
            void projects.refetch();
            void others.refetch();
            void queryClient.invalidateQueries({ queryKey: COUNTS_QUERY_KEY });
            void queryClient.invalidateQueries({ queryKey: PAGE_QUERY_KEY });
            void queryClient.invalidateQueries({ queryKey: PULL_REQUESTS_QUERY_KEY });
          }}
          style={s.iconButton}
        >
          {refreshing ? (
            <ActivityIndicator color={theme.colors.foregroundMuted} />
          ) : (
            <Icon name="RefreshCw" size={18} color={theme.colors.foregroundMuted} />
          )}
        </Pressable>
        {onOpenSettings ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Issues Workspaces settings"
            onPress={onOpenSettings}
            style={s.iconButton}
          >
            <Icon name="Settings" size={18} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>

      {projects.isPending ? <ActivityIndicator color={theme.colors.foregroundMuted} /> : null}
      {projects.isError ? <Text style={s.error}>Could not load projects: {message(projects.error)}</Text> : null}
      {projects.data && !options.length ? (
        <Text style={s.muted}>
          None of your Paseo projects has a github.com remote. Add a GitHub repository as a project to see its issues
          here.
        </Text>
      ) : null}

      {selected ? (
        <>
          {/* Above the screen's dismiss layer, so the header's dropdown can be pressed. */}
          <View style={{ zIndex: 6 }}>
            <RepoTable
              project={selected}
              query={query}
              page={page}
              onPageChange={(next) => {
                setPage(next);
                setOpenMenu(null);
                // Like following a page link on github.com: start reading from the top.
                scroller.current?.scrollTo({ y: 0, animated: false });
              }}
              density={density}
              branchPrefix={prefs.branchPrefix}
              otherHostWorkspaces={others.data?.workspaces}
              pendingNumber={pending}
              busy={pending !== null}
              onCreate={(issue, action) => create.mutate({ project: selected, issue, action })}
              agentLabel={
                prefs.agent ||
                (selected.remote ? `${selected.remote.hostLabel}'s default agent` : "the host's default agent")
              }
              menuOpen={openMenu !== null}
              createMenuFor={createMenu}
              onCreateMenu={openCreateMenu}
              pullRequestsFor={pullRequestsMenu}
              onPullRequestsMenu={openPullRequestsMenu}
              onDismissMenu={() => setOpenMenu(null)}
              headerControls={
                <FilterControls
                  repo={selected.repo}
                  query={query}
                  onQueryChange={search}
                  density={density}
                  onDensityChange={(next) => {
                    setDensityChoice(next);
                    void savePreferences({ density: next });
                  }}
                  openMenu={openMenu}
                  onOpenMenu={setOpenMenu}
                  theme={theme}
                  layout={layout}
                />
              }
              theme={theme}
              layout={layout}
              navigation={navigation}
            />
          </View>
        </>
      ) : null}

    </ScrollView>
  );
}
