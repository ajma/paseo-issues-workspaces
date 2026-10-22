import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { filterOptionsRpc, SORT_LABELS, SORTS, type Density, type Sort } from "../shared/issues";
import { isDarkTheme, issueTypeColor, labelColors } from "./github-style";
import {
  filterValues,
  hasNone,
  personSelected,
  setFilter,
  setNone,
  toggleFilter,
  type FilterKey,
} from "./query-filters";

type Theme = PluginScreenProps["theme"];
export type MenuId = FilterKey | "sort";

/** Labels combine, so only they show a count; the others hold one value. */
const MENUS: { id: FilterKey; label: string; title: string; multiple?: boolean }[] = [
  { id: "author", label: "Author", title: "Filter by author" },
  { id: "label", label: "Labels", title: "Filter by label", multiple: true },
  { id: "milestone", label: "Milestones", title: "Filter by milestone" },
  { id: "assignee", label: "Assignees", title: "Filter by assignee" },
  { id: "type", label: "Types", title: "Filter by type" },
];

type Item = {
  key: string;
  label: string;
  description?: string | null;
  selected: boolean;
  leading?: ReactNode;
  onPress: () => void;
};

/**
 * GitHub's filters for one repository, shown in the issue table's header. Each menu edits the
 * search query, so the search box always shows what is applied. The sort menu sets the order.
 */
export function FilterControls({
  repo,
  query,
  onQueryChange,
  sort,
  onSortChange,
  density,
  onDensityChange,
  openMenu,
  onOpenMenu,
  theme,
  layout,
}: Pick<PluginScreenProps, "theme" | "layout"> & {
  repo: string;
  query: string;
  onQueryChange: (query: string) => void;
  sort: Sort;
  onSortChange: (sort: Sort) => void;
  density: Density;
  onDensityChange: (density: Density) => void;
  openMenu: MenuId | null;
  onOpenMenu: (menu: MenuId | null) => void;
}) {
  const fetchOptions = useRpc(filterOptionsRpc);
  // Where each button sits, so its dropdown opens under it.
  const [buttons, setButtons] = useState<Partial<Record<MenuId, { x: number; width: number }>>>({});
  const [width, setWidth] = useState(0);
  const options = useQuery({
    queryKey: ["issues.filter-options", repo],
    queryFn: () => fetchOptions({ repo }),
    staleTime: 5 * 60_000,
  });
  const dark = isDarkTheme(theme);
  const me = options.data?.me ?? null;

  const apply = (next: string, close: boolean) => {
    onQueryChange(next);
    if (close) onOpenMenu(null);
  };

  function items(menu: MenuId): { none?: Item; list: Item[]; custom?: (text: string) => Item | null } {
    if (menu === "sort") {
      return {
        list: SORTS.map((id) => ({
          key: id,
          label: SORT_LABELS[id],
          selected: id === sort,
          onPress: () => {
            onSortChange(id);
            onOpenMenu(null);
          },
        })),
      };
    }
    const data = options.data;
    if (!data) return { list: [] };
    const person = (key: "author" | "assignee") => {
      const choose = (login: string) => {
        const selected = personSelected(query, key, login, me);
        apply(setFilter(query, key, selected ? null : login === me ? "@me" : login), true);
      };
      return {
        list: data.users.map((u) => ({
          key: u.login,
          label: u.login,
          description: u.login === me ? "You" : null,
          selected: personSelected(query, key, u.login, me),
          leading: u.avatarUrl ? <Image source={{ uri: u.avatarUrl }} style={{ width: 20, height: 20, borderRadius: 10 }} /> : null,
          onPress: () => choose(u.login),
        })),
        // Anyone can be typed in, as on GitHub.
        custom: (text: string) =>
          /^[a-z0-9-]+(\[bot\])?$/i.test(text) && !data.users.some((u) => u.login.toLowerCase() === text.toLowerCase())
            ? { key: `custom:${text}`, label: text, selected: false, onPress: () => choose(text) }
            : null,
      };
    };
    switch (menu) {
      case "author":
        return person("author");
      case "assignee":
        return {
          ...person("assignee"),
          none: {
            key: "none",
            label: "Assigned to nobody",
            selected: hasNone(query, "assignee"),
            onPress: () => apply(setNone(query, "assignee", !hasNone(query, "assignee")), true),
          },
        };
      case "label":
        return {
          none: {
            key: "none",
            label: "No labels",
            selected: hasNone(query, "label"),
            onPress: () => apply(setNone(query, "label", !hasNone(query, "label")), false),
          },
          list: data.labels.map((l) => ({
            key: l.name,
            label: l.name,
            description: l.description,
            selected: filterValues(query, "label").some((v) => v.toLowerCase() === l.name.toLowerCase()),
            leading: <Dot color={labelColors(l.color, false).backgroundColor} />,
            onPress: () => apply(toggleFilter(query, "label", l.name), false),
          })),
        };
      case "milestone":
        return {
          none: {
            key: "none",
            label: "No milestone",
            selected: hasNone(query, "milestone"),
            onPress: () => apply(setNone(query, "milestone", !hasNone(query, "milestone")), true),
          },
          list: data.milestones.map((m) => singleChoice("milestone", m.title, m.description)),
        };
      case "type":
        return {
          list: data.types.map((t) => ({
            ...singleChoice("type", t.name, t.description),
            leading: <Dot color={issueTypeColor(t.color, dark)} />,
          })),
        };
    }
  }

  function singleChoice(key: FilterKey, value: string, description: string | null): Item {
    const selected = filterValues(query, key).some((v) => v.toLowerCase() === value.toLowerCase());
    return {
      key: value,
      label: value,
      description,
      selected,
      onPress: () => apply(setFilter(query, key, selected ? null : value), true),
    };
  }

  const active = (menu: FilterKey) => filterValues(query, menu).length + (hasNone(query, menu) ? 1 : 0);
  const current =
    openMenu === "sort"
      ? { id: "sort" as const, label: "Sort", title: "Sort by" }
      : MENUS.find((m) => m.id === openMenu);

  const menuButton = (id: MenuId, accessibilityLabel: string, children: ReactNode) => {
    const open = openMenu === id;
    return (
      <Pressable
        key={id}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        aria-expanded={open}
        onPress={() => onOpenMenu(open ? null : id)}
        onLayout={(e) => {
          const { x, width: w } = e.nativeEvent.layout;
          setButtons((current) => ({ ...current, [id]: { x, width: w } }));
        }}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingVertical: 5,
          paddingHorizontal: 8,
          borderRadius: 6,
          backgroundColor: open || pressed ? theme.colors.surface2 : "transparent",
        })}
      >
        {children}
        <Icon name="ChevronDown" size={14} color={theme.colors.foregroundMuted} />
      </Pressable>
    );
  };
  const buttonsRow = MENUS.map((m) => {
    const count = active(m.id);
    return menuButton(
      m.id,
      !count ? m.label : m.multiple ? `${m.label}, ${count} applied` : `${m.label}, filtered`,
      <>
        <Text
          style={{
            color: count ? theme.colors.foreground : theme.colors.foregroundMuted,
            fontSize: 14,
            fontWeight: count ? "600" : "400",
          }}
        >
          {m.label}
        </Text>
        {count && m.multiple ? (
          <View style={{ minWidth: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: theme.colors.surface2 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 11, textAlign: "center" }}>{count}</Text>
          </View>
        ) : null}
      </>,
    );
  });
  // GitHub's sort menu sits after the filters and names the current order.
  buttonsRow.push(
    menuButton(
      "sort",
      `Sort, ${SORT_LABELS[sort]}`,
      <>
        <Icon name="ArrowUpDown" size={14} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>{SORT_LABELS[sort]}</Text>
      </>,
    ),
  );
  const anchor = current ? buttons[current.id] : undefined;

  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, zIndex: 10 }}
    >
      {layout.compact ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ gap: 2 }}>
          {buttonsRow}
        </ScrollView>
      ) : (
        <View style={{ flexDirection: "row", gap: 2 }}>{buttonsRow}</View>
      )}
      <DensityToggle density={density} onChange={onDensityChange} theme={theme} />

      {current ? (
        <FilterMenu
          // Each menu starts with an empty search; the sort menu has no box to clear one.
          key={current.id}
          title={current.title}
          // Six fixed orders need no search box or loading state.
          placeholder={current.id === "sort" ? undefined : `Filter ${current.label.toLowerCase()}`}
          loading={current.id !== "sort" && options.isPending}
          error={current.id !== "sort" && options.isError ? String(options.error) : null}
          {...items(current.id)}
          // Native platforms deliver no touches outside a parent's bounds, so a dropdown hanging
          // below the header could not be pressed there: they get the sheet.
          compact={layout.compact || layout.platform !== "web"}
          theme={theme}
          onClose={() => onOpenMenu(null)}
          // Right-aligned under its button, like GitHub's dropdowns at the right of a table header.
          right={anchor ? Math.max(0, width - (anchor.x + anchor.width)) : 0}
        />
      ) : null}
    </View>
  );
}

function Dot({ color }: { color: string }) {
  return <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: color }} />;
}

/** A filter dropdown: anchored under the bar on wide layouts, a sheet on narrow ones. */
function FilterMenu({
  title,
  placeholder,
  loading,
  error,
  none,
  list,
  custom,
  compact,
  theme,
  onClose,
  right,
}: {
  title: string;
  /** Labels the search box; a menu without one has no search box. */
  placeholder?: string;
  loading: boolean;
  error: string | null;
  none?: Item;
  list: Item[];
  custom?: (text: string) => Item | null;
  compact: boolean;
  theme: Theme;
  onClose: () => void;
  right: number;
}) {
  const [text, setText] = useState("");
  const needle = text.trim().toLowerCase();
  const shown = list.filter((i) => !needle || i.label.toLowerCase().includes(needle)).slice(0, 100);
  const extra = needle && custom ? custom(text.trim()) : null;

  const body = (
    <View style={{ gap: 4 }}>
      {placeholder ? (
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={placeholder}
          style={{
            margin: 8,
            paddingVertical: 6,
            paddingHorizontal: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 6,
            color: theme.colors.foreground,
            backgroundColor: theme.colors.surface0,
            fontSize: 14,
          }}
        />
      ) : null}
      {loading ? <Text style={{ color: theme.colors.foregroundMuted, padding: 12 }}>Loading…</Text> : null}
      {error ? <Text style={{ color: theme.colors.statusDanger, padding: 12 }}>{error}</Text> : null}
      <ScrollView style={{ maxHeight: compact ? undefined : 320 }}>
        {none && !needle ? <MenuRow item={none} theme={theme} /> : null}
        {shown.map((item) => (
          <MenuRow key={item.key} item={item} theme={theme} />
        ))}
        {extra ? <MenuRow item={extra} theme={theme} /> : null}
        {!loading && !error && !shown.length && !extra ? (
          <Text style={{ color: theme.colors.foregroundMuted, padding: 12 }}>No matches</Text>
        ) : null}
      </ScrollView>
    </View>
  );

  if (compact) {
    return (
      <Modal title={title} open onOpenChange={(open) => !open && onClose()}>
        <Modal.Content contentContainerStyle={{ padding: 0, gap: 0 }}>{body}</Modal.Content>
      </Modal>
    );
  }
  return (
    <View
      accessibilityRole="menu"
      accessibilityLabel={title}
      style={{
        position: "absolute",
        top: "100%",
        right,
        marginTop: 4,
        width: 300,
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
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", paddingTop: 12, paddingHorizontal: 12 }}>
        {title}
      </Text>
      {body}
    </View>
  );
}

function MenuRow({ item, theme }: { item: Item; theme: Theme }) {
  return (
    <Pressable
      accessibilityRole="menuitem"
      aria-checked={item.selected}
      accessibilityLabel={item.label}
      onPress={item.onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 7,
        paddingHorizontal: 12,
        backgroundColor: pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      <View style={{ width: 16 }}>
        {item.selected ? <Icon name="Check" size={16} color={theme.colors.foreground} /> : null}
      </View>
      {item.leading}
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 14 }} numberOfLines={1}>
          {item.label}
        </Text>
        {item.description ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
            {item.description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** GitHub's two list densities, with their names shown on hover. */
export function DensityToggle({
  density,
  onChange,
  theme,
}: {
  density: Density;
  onChange: (density: Density) => void;
  theme: Theme;
}) {
  const options: { value: Density; icon: string; label: string }[] = [
    { value: "comfortable", icon: "Rows2", label: "Comfortable" },
    { value: "compact", icon: "Rows4", label: "Compact" },
  ];
  const [hovered, setHovered] = useState<Density | null>(null);
  return (
    <View
      style={{ flexDirection: "row", borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6 }}
    >
      {options.map((o, i) => {
        const selected = o.value === density;
        return (
          <View key={o.value}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${o.label} density`}
              aria-selected={selected}
              onPress={() => onChange(o.value)}
              onHoverIn={() => setHovered(o.value)}
              onHoverOut={() => setHovered(null)}
              style={{
                paddingVertical: 6,
                paddingHorizontal: 8,
                backgroundColor: selected ? theme.colors.surface2 : "transparent",
                borderLeftWidth: i ? 1 : 0,
                borderLeftColor: theme.colors.border,
              }}
            >
              <Icon name={o.icon} size={16} color={selected ? theme.colors.foreground : theme.colors.foregroundMuted} />
            </Pressable>
            {hovered === o.value ? <Tooltip text={o.label} theme={theme} /> : null}
          </View>
        );
      })}
    </View>
  );
}

/** GitHub's dark tooltip bubble, under the control it describes. */
function Tooltip({ text, theme }: { text: string; theme: Theme }) {
  const dark = isDarkTheme(theme);
  return (
    <View
      accessibilityRole="text"
      pointerEvents="none"
      style={{
        position: "absolute",
        top: "100%",
        right: 0,
        marginTop: 6,
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 6,
        backgroundColor: dark ? "#3d444d" : "#25292e",
        zIndex: 30,
      }}
    >
      <Text style={{ color: "#ffffff", fontSize: 12 }} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}
