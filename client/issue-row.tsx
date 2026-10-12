import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View, type Role } from "react-native";
import type { CreateAction, Density, Issue, PullRequest } from "../shared/issues";
import { isDarkTheme, labelColors, openIssueColor, timeAgo } from "./github-style";
import type { RemoteWorkspace } from "./issue-list";
import { PR_COLUMN_WIDTH, PullRequestsCell, WORKSPACE_COLUMN_WIDTH } from "./pull-request-status";

type Props = Pick<PluginScreenProps, "theme" | "layout" | "navigation">;

/**
 * One issue, laid out like a row of GitHub's issue list. Comfortable puts the number, age
 * and author on a second line; compact keeps them on the title line.
 */
export function IssueRow({
  issue,
  pullRequests,
  density,
  elsewhere,
  first,
  pending,
  busy,
  onCreate,
  agentLabel,
  workspaceServerId,
  menuOpen = false,
  onMenuOpenChange,
  pullRequestsOpen = false,
  onPullRequestsOpenChange,
  theme,
  layout,
  navigation,
}: Props & {
  issue: Issue;
  pullRequests?: PullRequest[];
  density: Density;
  /** Workspaces for this issue on other hosts. */
  elsewhere: RemoteWorkspace[];
  /** The first row in its box draws no divider above it. */
  first: boolean;
  pending: boolean;
  busy: boolean;
  onCreate: (action: CreateAction) => void;
  /** Names the agent "Create and start" starts. */
  agentLabel: string;
  /** The host whose workspace covers this issue, when it is not the selected host. */
  workspaceServerId?: string;
  /** This row's create menu is open; the row is raised so the dropdown paints over the rows below. */
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  pullRequestsOpen?: boolean;
  onPullRequestsOpenChange?: (open: boolean) => void;
}) {
  const dark = isDarkTheme(theme);
  const dense = density === "compact";
  const s = useMemo(
    () => ({
      row: {
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        gap: 8,
        paddingVertical: dense ? 5 : 10,
        paddingHorizontal: layout.compact ? 12 : 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.border,
      },
      icon: { paddingTop: dense ? 2 : 3 },
      body: {
        flex: 1,
        minWidth: 0,
        flexDirection: (layout.compact ? "column" : "row") as "column" | "row",
        alignItems: (layout.compact ? "stretch" : "center") as "stretch" | "center",
        gap: layout.compact ? (dense ? 4 : 8) : 8,
      },
      text: { flex: layout.compact ? undefined : 1, minWidth: 0, marginRight: layout.compact ? 0 : 8, gap: dense ? 2 : 4 },
      titleLine: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 6 },
      title: { color: theme.colors.foreground, fontSize: dense ? 14 : 16, fontWeight: "600" as const },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      link: { color: theme.colors.accent, fontSize: 12 },
    }),
    [theme, layout.compact, first, dense],
  );

  const opened = `#${issue.number} opened ${timeAgo(issue.createdAt)}${issue.author ? ` by ${issue.author}` : ""}`;

  return (
    <View testID={`issue-row-${issue.number}`} style={[s.row, menuOpen || pullRequestsOpen ? { zIndex: 7 } : null]}>
      <View style={s.icon}>
        <Icon name="CircleDot" size={16} color={openIssueColor(dark)} />
      </View>
      <View style={s.body}>
        <View style={s.text}>
          <View style={s.titleLine}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`Open issue ${issue.number} on GitHub: ${issue.title}`}
              onPress={() => void openExternalUrl(issue.url)}
              // Shrink to the line so a long title wraps instead of widening the row.
              style={{ flexShrink: 1 }}
            >
              <Text style={s.title}>{issue.title}</Text>
            </Pressable>
            {issue.labels.map((label) => (
              <IssueLabel key={label.name} name={label.name} color={label.color} dark={dark} dense={dense} />
            ))}
            {dense ? <Text style={s.meta}>{opened}</Text> : null}
          </View>
          {dense ? null : <Text style={s.meta}>{opened}</Text>}
          {issue.orphanBranch ? (
            <Text style={s.meta}>Local branch {issue.orphanBranch} exists without a workspace</Text>
          ) : null}
          {elsewhere.map((w) => (
            <ElsewhereLink key={`${w.serverId}/${w.workspaceId}`} workspace={w} style={s.link} navigation={navigation} />
          ))}
        </View>
        <View style={{ width: layout.compact ? undefined : PR_COLUMN_WIDTH, flexShrink: 0, zIndex: pullRequestsOpen ? 1 : 0 }}>
          <PullRequestsCell
            issueNumber={issue.number}
            pullRequests={pullRequests}
            open={pullRequestsOpen}
            onOpenChange={onPullRequestsOpenChange ?? (() => {})}
            theme={theme}
            layout={layout}
          />
        </View>
        <View style={{ width: layout.compact ? undefined : WORKSPACE_COLUMN_WIDTH, alignItems: "flex-start", flexShrink: 0 }}>
          <IssueAction
            issue={issue}
            pending={pending}
            busy={busy}
            dense={dense}
            theme={theme}
            onCreate={onCreate}
            agentLabel={agentLabel}
            menuOpen={menuOpen}
            onMenuOpenChange={onMenuOpenChange ?? (() => {})}
            sheet={layout.platform !== "web"}
            onOpen={
              issue.workspace && navigation
                ? () =>
                    navigation.openWorkspace(
                      workspaceServerId
                        ? { workspaceId: issue.workspace!.id, serverId: workspaceServerId }
                        : { workspaceId: issue.workspace!.id },
                    )
                : undefined
            }
          />
        </View>
      </View>
    </View>
  );
}

function IssueLabel({ name, color, dark, dense }: { name: string; color: string; dark: boolean; dense: boolean }) {
  const c = labelColors(color, dark);
  return (
    <View
      style={{
        paddingHorizontal: 7,
        paddingVertical: 1,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: c.borderColor,
        backgroundColor: c.backgroundColor,
      }}
    >
      <Text style={{ color: c.color, fontSize: 12, fontWeight: "500", lineHeight: dense ? 16 : 18 }}>{name}</Text>
    </View>
  );
}

function ElsewhereLink({
  workspace: w,
  style,
  navigation,
}: {
  workspace: RemoteWorkspace;
  style: object;
  navigation: PluginScreenProps["navigation"];
}) {
  const label = `Workspace on ${w.hostLabel}: ${w.name}`;
  if (!navigation) return <Text style={style}>{label}</Text>;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open workspace ${w.name} on ${w.hostLabel}`}
      onPress={() => navigation.openWorkspace({ workspaceId: w.workspaceId, serverId: w.serverId })}
    >
      <Text style={style}>{label}</Text>
    </Pressable>
  );
}

function IssueAction({
  issue,
  pending,
  busy,
  dense,
  theme,
  onCreate,
  agentLabel,
  menuOpen,
  onMenuOpenChange,
  sheet,
  onOpen,
}: {
  issue: Issue;
  pending: boolean;
  busy: boolean;
  dense: boolean;
  theme: PluginScreenProps["theme"];
  onCreate: (action: CreateAction) => void;
  agentLabel: string;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  /** Native platforms can't press a dropdown hanging outside its row, so they get a sheet. */
  sheet: boolean;
  onOpen?: () => void;
}) {
  // As on GitHub, the menu picks what the button does; the button does it.
  const [action, setAction] = useState<CreateAction>("create");
  const pad = { paddingVertical: dense ? 3 : 6, paddingHorizontal: dense ? 10 : 12 };
  const shell = {
    flexDirection: "row" as const,
    alignItems: "stretch" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 6,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden" as const,
  };
  const label = { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const };

  if (issue.workspace) {
    if (!onOpen) return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Has a workspace</Text>;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open workspace for issue ${issue.number}`}
        onPress={onOpen}
        style={[shell, pad, { alignItems: "center", gap: 6 }]}
      >
        <Icon name="SquareArrowOutUpRight" size={14} color={theme.colors.foregroundMuted} />
        <Text style={label}>Open workspace</Text>
      </Pressable>
    );
  }
  if (issue.orphanBranch) return null;

  const choices = [
    {
      action: "create" as const,
      icon: "GitBranchPlus",
      title: "Create workspace",
      button: "Create workspace",
      buttonLabel: `Create workspace for issue ${issue.number}`,
      description: "A worktree on a new branch from the default branch. No agent is started.",
    },
    {
      action: "agent" as const,
      icon: "Wrench",
      title: "Create and start an agent",
      button: "Create and start",
      buttonLabel: `Create workspace and start an agent on issue ${issue.number}`,
      description: `Also starts ${agentLabel} in the workspace with a prompt to work on this issue.`,
    },
  ];
  const current = choices.find((c) => c.action === action)!;
  const title = `Create a workspace for #${issue.number}`;
  const items = choices.map((c) => (
    <MenuItem
      key={c.action}
      icon={c.icon}
      title={c.title}
      description={c.description}
      selected={c.action === action}
      theme={theme}
      onPress={() => {
        setAction(c.action);
        onMenuOpenChange(false);
      }}
    />
  ));

  // GitHub's split button: the chosen action on the left, the choices behind the chevron.
  return (
    <View>
      <View style={[shell, busy && !pending ? { opacity: 0.5 } : null]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={current.buttonLabel}
          disabled={busy}
          onPress={() => onCreate(action)}
          style={[pad, { flexDirection: "row", alignItems: "center", gap: 6 }]}
        >
          {pending ? (
            <ActivityIndicator size="small" color={theme.colors.accent} />
          ) : (
            <Icon name={current.icon} size={16} color={theme.colors.accent} />
          )}
          <Text style={label}>{pending ? "Creating…" : current.button}</Text>
        </Pressable>
        <View style={{ width: 1, backgroundColor: theme.colors.border }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`More ways to create a workspace for issue ${issue.number}`}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          disabled={busy}
          onPress={() => onMenuOpenChange(!menuOpen)}
          style={({ pressed }) => ({
            justifyContent: "center",
            paddingHorizontal: dense ? 6 : 8,
            backgroundColor: menuOpen || pressed ? theme.colors.surface1 : "transparent",
          })}
        >
          <Icon name="ChevronDown" size={16} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      {menuOpen && !sheet ? (
        <View
          accessibilityRole="menu"
          accessibilityLabel={title}
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: 4,
            width: 320,
            maxWidth: 320,
            padding: 4,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 12,
            backgroundColor: theme.colors.surface1,
            shadowColor: "#000",
            shadowOpacity: 0.3,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 6 },
            elevation: 8,
            zIndex: 20,
          }}
        >
          {items}
        </View>
      ) : null}
      {sheet ? (
        <Modal title={title} open={menuOpen} onOpenChange={onMenuOpenChange}>
          <Modal.Content contentContainerStyle={{ padding: 8, gap: 2 }}>{items}</Modal.Content>
        </Modal>
      ) : null}
    </View>
  );
}

/** A choice in the split button's menu, checked when it is the button's current action. */
function MenuItem({
  icon,
  title,
  description,
  selected,
  theme,
  onPress,
}: {
  icon: string;
  title: string;
  description: string;
  selected: boolean;
  theme: PluginScreenProps["theme"];
  onPress: () => void;
}) {
  return (
    <Pressable
      // GitHub's role for these; React Native's types omit it, react-native-web passes it through.
      role={"menuitemradio" as Role}
      aria-checked={selected}
      accessibilityLabel={title}
      accessibilityHint={description}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        paddingVertical: 8,
        paddingHorizontal: 8,
        borderRadius: 6,
        backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      <View style={{ width: 16, paddingTop: 1 }}>
        {selected ? <Icon name="Check" size={16} color={theme.colors.foreground} /> : null}
      </View>
      <View style={{ paddingTop: 1 }}>
        <Icon name={icon} size={16} color={theme.colors.accent} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: selected ? "600" : "400" }}>{title}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{description}</Text>
      </View>
    </Pressable>
  );
}
