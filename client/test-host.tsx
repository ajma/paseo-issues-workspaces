// Test doubles for the modules the Paseo app provides to plugin bundles. Used only by *.test.tsx.
import { createElement, useState, type ReactNode } from "react";
import { ScrollView as RNScrollView, TextInput as RNTextInput } from "react-native";
import type { Preferences } from "../shared/issues";

type Rpc = (input: unknown) => Promise<unknown>;

export const host = {
  rpcs: new Map<string, Rpc>(),
  settings: null as null | {
    status: "ready" | "loading" | "invalid" | "error";
    values: Preferences;
    revision: string;
    saving: boolean;
    saveError: string | null;
    save: (values: Preferences, revision: string) => Promise<boolean>;
    reset: () => Promise<boolean>;
    reload: () => Promise<void>;
    error?: string;
  },
  hosts: [] as { serverId: string; label: string; status: string }[],
  remoteWorkspaces: new Map<string, unknown[]>(),
  remoteProjects: new Map<string, unknown[]>(),
  remoteProviders: new Map<string, unknown[]>(),
  /** Other hosts' project lists wait for this, to test what shows before they arrive. */
  remoteProjectsGate: Promise.resolve(),
  /** Workspaces and agents created through another host's connection, by server id. */
  remoteCreated: [] as { serverId: string; options: any }[],
  remoteAgents: [] as { serverId: string; options: any }[],
  toasts: [] as { message: string; variant?: string }[],
  opened: [] as string[],
  providers: [] as unknown[],
};

export const clientModule = {
  useRpc: (contract: { name: string }) => (input: unknown) => {
    const rpc = host.rpcs.get(contract.name);
    if (!rpc) throw new Error(`no fake for ${contract.name}`);
    return rpc(input);
  },
  useSettings: () => host.settings,
  useHosts: () => host.hosts,
  getPaseoClient: (serverId: string) => ({
    workspaces: {
      list: async () => ({ entries: host.remoteWorkspaces.get(serverId) ?? [], pageInfo: { hasMore: false } }),
      create: async (options: any) => {
        host.remoteCreated.push({ serverId, options });
        return {
          id: `wks_on_${serverId}`,
          agents: {
            create: async (agentOptions: any) => {
              host.remoteAgents.push({ serverId, options: agentOptions });
              return { id: `agt_on_${serverId}` };
            },
          },
        };
      },
    },
    projects: {
      list: async () => {
        await host.remoteProjectsGate;
        return { projects: host.remoteProjects.get(serverId) ?? [] };
      },
    },
    providers: { snapshot: async () => ({ entries: host.remoteProviders.get(serverId) ?? [] }) },
  }),
  usePaseo: () => ({ providers: { snapshot: async () => ({ entries: host.providers }) } }),
  openExternalUrl: async (url: string) => {
    host.opened.push(url);
  },
};

export const reactNativeModule = {
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement("span", { "data-icon": name, "data-color": color }),
  ScrollView: RNScrollView,
  TextInput: RNTextInput,
  useToast: () => ({
    show: (message: string, options?: { variant?: string }) => host.toasts.push({ message, variant: options?.variant }),
    error: (message: string) => host.toasts.push({ message, variant: "error" }),
  }),
  Modal: Object.assign(
    ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
      open ? createElement("div", { role: "dialog", "aria-label": title }, children) : null,
    { Content: ({ children }: { children: ReactNode }) => createElement("div", null, children) },
  ),
};

/** Settings components as plain form controls, labelled for queries. */
export const uiModule = {
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) =>
    createElement("section", { "aria-label": title }, children),
  SettingsCard: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  SettingsRow: ({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) =>
    createElement("div", { "aria-label": label, title: hint }, children),
  SettingsInput: function SettingsInput({
    label,
    initialValue,
    onChangeText,
    error,
  }: {
    label: string;
    initialValue?: string;
    onChangeText: (text: string) => void;
    error?: string;
  }) {
    const [value, setValue] = useState(initialValue ?? "");
    return createElement(
      "label",
      null,
      label,
      createElement("input", {
        "aria-label": label,
        value,
        onChange: (e: { target: { value: string } }) => {
          setValue(e.target.value);
          onChangeText(e.target.value);
        },
      }),
      error ? createElement("span", { role: "alert" }, error) : null,
    );
  },
  SettingsSelect: ({
    label,
    value,
    options,
    onValueChange,
  }: {
    label: string;
    value: string;
    options: { label: string; value: string }[];
    onValueChange: (value: string) => void;
  }) =>
    createElement(
      "select",
      { "aria-label": label, value, onChange: (e: { target: { value: string } }) => onValueChange(e.target.value) },
      options.map((o) => createElement("option", { key: o.value, value: o.value }, o.label)),
    ),
  SettingsAction: ({
    label,
    actionLabel,
    disabled,
    onPress,
  }: {
    label: string;
    actionLabel: string;
    disabled?: boolean;
    onPress: () => void;
  }) => createElement("button", { "aria-label": `${label}: ${actionLabel}`, disabled, onClick: onPress }, actionLabel),
};

/** A ready settings document whose saves are recorded and applied. */
export function readySettings(values: Preferences) {
  const saves: Preferences[] = [];
  host.settings = {
    status: "ready",
    values,
    revision: "r1",
    saving: false,
    saveError: null,
    save: async (next) => {
      saves.push(next);
      return true;
    },
    reset: async () => true,
    reload: async () => {},
  };
  return saves;
}

export function resetHost() {
  host.rpcs.clear();
  host.remoteProjectsGate = Promise.resolve();
  host.settings = null;
  host.hosts = [];
  host.remoteWorkspaces.clear();
  host.remoteProjects.clear();
  host.remoteProviders.clear();
  host.remoteCreated = [];
  host.remoteAgents = [];
  host.toasts = [];
  host.opened = [];
  host.providers = [];
}
