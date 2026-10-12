import { openExternalUrl, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { Pressable, ScrollView, Text, View, type Role } from "react-native";
import type { PullRequest } from "../shared/issues";

type Status = { label: string; tone: "foregroundMuted" | "statusSuccess" | "statusWarning" | "statusDanger" };

function reviewStatus(pr: PullRequest): Status {
  switch (pr.reviewDecision) {
    case "APPROVED": return { label: "Approved", tone: "statusSuccess" };
    case "CHANGES_REQUESTED": return { label: "Changes requested", tone: "statusDanger" };
    case "REVIEW_REQUIRED": return { label: "Review required", tone: "statusWarning" };
    default: return { label: "No review decision", tone: "foregroundMuted" };
  }
}

function mergeStatus(pr: PullRequest): Status {
  if (pr.isDraft) return { label: "Draft", tone: "foregroundMuted" };
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
    return { label: "Merge conflicts", tone: "statusDanger" };
  }
  switch (pr.mergeStateStatus) {
    case "BLOCKED": return { label: "Merge blocked", tone: "statusWarning" };
    case "BEHIND": return { label: "Branch out of date", tone: "statusWarning" };
    case "UNSTABLE": return { label: "Checks not passing", tone: "statusWarning" };
    case "DRAFT": return { label: "Draft", tone: "foregroundMuted" };
    case "CLEAN":
    case "HAS_HOOKS":
      if (pr.mergeable === "MERGEABLE") return { label: "Mergeable", tone: "statusSuccess" };
  }
  return { label: "Mergeability unknown", tone: "foregroundMuted" };
}

/** Closed history never displaces active work; within open PRs, surface actionable problems first. */
function attention(pr: PullRequest) {
  if (pr.state !== "OPEN") return pr.state === "MERGED" ? 7 : 8;
  if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return 0;
  if (["BLOCKED", "UNSTABLE", "BEHIND"].includes(pr.mergeStateStatus)) return 1;
  if (pr.isDraft) return 5;
  if (pr.reviewDecision === "REVIEW_REQUIRED") return 2;
  if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN") return 3;
  return 4;
}

export const PR_COLUMN_WIDTH = 160;
export const WORKSPACE_COLUMN_WIDTH = 204;

/** One compact summary with stacked states, regardless of PR count. The full list never participates in row layout. */
export function PullRequestsCell({
  issueNumber, pullRequests, open, onOpenChange, theme, layout,
}: Pick<PluginScreenProps, "theme" | "layout"> & {
  issueNumber: number;
  pullRequests: PullRequest[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sorted = [...(pullRequests ?? [])].sort((a, b) => attention(a) - attention(b));
  const primary = sorted[0];
  const sheet = layout.compact || layout.platform !== "web";
  const title = `Pull requests for issue ${issueNumber}`;
  const moreLabel = `Show all ${sorted.length} pull requests for issue ${issueNumber}`;
  const meta = { color: theme.colors.foregroundMuted, fontSize: 12 };
  if (!primary) return (
    <View style={{ height: 54, justifyContent: "center" }}>
      <Text style={meta}>{pullRequests ? "No linked PR" : "PR status unavailable"}</Text>
    </View>
  );
  const review = reviewStatus(primary);
  const merge = primary.state === "OPEN" ? mergeStatus(primary) : {
    label: primary.state === "MERGED" ? "Merged" : "Closed", tone: "foregroundMuted" as const,
  };
  const closeButton = (
    <Pressable accessibilityRole="button" accessibilityLabel="Close pull requests" onPress={() => onOpenChange(false)} style={{ padding: 8 }}>
      <Icon name="X" size={16} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
  const body = (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 12 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{title}</Text>
        {closeButton}
      </View>
      <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ padding: 12, paddingTop: 0, gap: 16 }}>
        {sorted.map((pr) => <PullRequestStatus key={pr.url} pr={pr} theme={theme} />)}
      </ScrollView>
    </>
  );
  return (
    <View>
      <View style={{ height: 54, gap: 2 }}>
        <View style={{ height: 20, flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open pull request ${primary.number} on GitHub: ${primary.title}`}
            onPress={() => void openExternalUrl(primary.url)}
            style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}
          >
            <Icon name={primary.state === "MERGED" ? "GitMerge" : "GitPullRequest"} size={14} color={theme.colors.accent} />
            <Text numberOfLines={1} style={{ color: theme.colors.accent, fontSize: 12, lineHeight: 16 }}>#{primary.number}</Text>
          </Pressable>
          {sorted.length > 1 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={moreLabel}
              aria-expanded={open}
              aria-haspopup="dialog"
              onPress={() => onOpenChange(!open)}
              style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: theme.colors.surface2 }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 16 }}>+{sorted.length - 1}</Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`PR ${primary.number}: ${review.label}, ${merge.label}. Show details for issue ${issueNumber}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          onPress={() => onOpenChange(!open)}
          style={{ minWidth: 0 }}
        >
          <Text numberOfLines={1} style={{ color: theme.colors[review.tone], fontSize: 12, lineHeight: 16 }}>
            {review.label}
          </Text>
          <Text numberOfLines={1} style={{ color: theme.colors[merge.tone], fontSize: 12, lineHeight: 16 }}>
            {merge.label}
          </Text>
        </Pressable>
      </View>
      {open && !sheet ? (
        <View
          role={"dialog" as Role}
          accessibilityLabel={title}
          style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, width: 360,
            borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.surface1,
            shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 8, zIndex: 20 }}
        >
          {body}
        </View>
      ) : null}
      {open && sheet ? (
        <Modal title={title} open onOpenChange={onOpenChange}>
          <Modal.Content contentContainerStyle={{ padding: 0 }}>{body}</Modal.Content>
        </Modal>
      ) : null}
    </View>
  );
}

/** A direct PR link with separate review and merge states; labels also convey the colors. */
export function PullRequestStatus({ pr, theme }: { pr: PullRequest } & Pick<PluginScreenProps, "theme">) {
  const review = reviewStatus(pr);
  const merge = mergeStatus(pr);
  const closed = pr.state !== "OPEN";
  return (
    <View style={{ alignItems: "flex-start", gap: 2 }}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Open pull request ${pr.number} on GitHub: ${pr.title}`}
        onPress={() => void openExternalUrl(pr.url)}
        style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }}
      >
        <Icon name={pr.state === "MERGED" ? "GitMerge" : "GitPullRequest"} size={14} color={theme.colors.accent} />
        <Text style={{ color: theme.colors.accent, fontSize: 12, flexShrink: 1 }}>PR #{pr.number}: {pr.title}</Text>
      </Pressable>
      <Text style={{ color: theme.colors[review.tone], fontSize: 12 }}>{review.label}</Text>
      <Text style={{ color: theme.colors[closed ? "foregroundMuted" : merge.tone], fontSize: 12 }}>
        {closed ? (pr.state === "MERGED" ? "Merged" : "Closed") : merge.label}
      </Text>
    </View>
  );
}
