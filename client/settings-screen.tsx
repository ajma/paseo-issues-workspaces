import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useSettings } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Text } from "react-native";
import {
  branchPrefixError,
  defaultAgent,
  effectiveAgentPrompt,
  effortChoices,
  DEFAULT_AGENT_PROMPT,
  MAX_OWNERS,
  parseOwners,
  preferences,
  PROMPT_PLACEHOLDERS,
  type Preferences,
  type ProviderEntry,
} from "../shared/issues";

const AUTOMATIC = "";
const MODEL_DEFAULT = "";

type Option = { value: string; label: string };

/** The host's ready providers, and their models as `provider/model` choices. */
function useProviders() {
  const paseo = usePaseo();
  return useQuery({
    queryKey: ["providers.snapshot"],
    queryFn: async () => {
      const { entries } = await paseo.providers.snapshot();
      const ready = entries.filter((p) => p.enabled !== false && p.status === "ready");
      const agentOptions = ready.flatMap((p) =>
        (p.models ?? [])
          .filter((m) => m.isSelectable !== false)
          .map((m) => ({ value: `${p.provider}/${m.id}`, label: `${p.label ?? p.provider} · ${m.label}` })),
      );
      return { entries: ready as ProviderEntry[], agentOptions };
    },
  });
}

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const providers = useProviders();
  const settings = useSettings(preferences);
  const errorStyle = { color: theme.colors.statusDanger };

  if (settings.status === "loading") return <ActivityIndicator color={theme.colors.foregroundMuted} />;
  if (settings.status === "error") return <Text style={errorStyle}>Could not load settings: {settings.error}</Text>;
  if (settings.status === "invalid") {
    return (
      <SettingsSection title="Settings">
        <SettingsCard>
          <SettingsAction
            label="Saved settings are invalid"
            hint={settings.error}
            actionLabel="Reset to defaults"
            disabled={settings.saving}
            onPress={() => void settings.reset()}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }
  return (
    <PreferencesForm
      // A save from any client starts a fresh draft from the new values.
      key={settings.revision}
      values={settings.values}
      theme={theme}
      providers={providers.data?.entries ?? []}
      agentOptions={providers.data?.agentOptions ?? []}
      saving={settings.saving}
      saveError={settings.saveError}
      onSave={(values) => settings.save(values, settings.revision)}
    />
  );
}

function PreferencesForm({
  values,
  theme,
  providers,
  agentOptions,
  saving,
  saveError,
  onSave,
}: {
  values: Preferences;
  theme: PluginSurfaceProps["theme"];
  providers: ProviderEntry[];
  agentOptions: Option[];
  saving: boolean;
  saveError: string | null;
  onSave: (values: Preferences) => Promise<boolean>;
}) {
  const [branchPrefix, setBranchPrefix] = useState(values.branchPrefix);
  const [agent, setAgent] = useState(values.agent);
  const [effort, setEffort] = useState(values.effort);
  const savedPrompt = effectiveAgentPrompt(values.agentPrompt);
  const [agentPrompt, setAgentPrompt] = useState(savedPrompt);
  const savedOwners = values.owners.join(", ");
  const [ownersText, setOwnersText] = useState(savedOwners);
  const owners = parseOwners(ownersText);
  const prefixError = branchPrefixError(branchPrefix);
  const changed =
    branchPrefix !== values.branchPrefix ||
    agent !== values.agent ||
    effort !== values.effort ||
    agentPrompt !== savedPrompt ||
    owners?.join(", ") !== savedOwners;
  // A saved agent the host no longer offers stays selectable, so opening settings never changes it.
  const options = [
    { value: AUTOMATIC, label: "Automatic: first ready provider, default model" },
    ...agentOptions,
    ...(agent && !agentOptions.some((o) => o.value === agent) ? [{ value: agent, label: agent }] : []),
  ];
  // Effort levels belong to a model; Automatic offers those of the model it would pick today.
  const efforts = effortChoices(providers, agent || (defaultAgent(providers) ?? ""));
  const defaultLabel = efforts.options.find((o) => o.id === efforts.defaultId)?.label;
  const effortOptions: Option[] = [
    { value: MODEL_DEFAULT, label: defaultLabel ? `Model default (${defaultLabel})` : "Model default" },
    ...efforts.options.map((o) => ({ value: o.id, label: o.label })),
    // Like the agent, a saved effort the model no longer lists stays as it is.
    ...(effort && !efforts.options.some((o) => o.id === effort) ? [{ value: effort, label: effort }] : []),
  ];
  const chooseAgent = (next: string) => {
    setAgent(next);
    // A level the newly chosen model lacks would be ignored, so start from its default instead.
    const offered = effortChoices(providers, next || (defaultAgent(providers) ?? "")).options;
    if (effort && !offered.some((o) => o.id === effort)) setEffort(MODEL_DEFAULT);
  };

  return (
    <>
      <SettingsSection title="New workspaces">
        <SettingsCard>
          <SettingsInput
            label="Branch prefix"
            hint={`Branches are named ${branchPrefix || ""}<number>-<title>, from the repository's default branch.`}
            placeholder="issue/"
            initialValue={values.branchPrefix}
            onChangeText={setBranchPrefix}
            error={prefixError ?? undefined}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Create and start an agent">
        <SettingsCard>
          <SettingsSelect
            label="Agent"
            hint="The provider and model started in the new workspace."
            value={agent}
            options={options}
            onValueChange={chooseAgent}
          />
          <SettingsSelect
            label="Effort"
            hint="How hard the agent thinks. The levels are the chosen model's; a level that model lacks uses its default."
            value={effort}
            options={effortOptions}
            onValueChange={setEffort}
          />
          <SettingsRow
            label="Agent prompt"
            hint={`Sent as the agent's first message. Placeholders: ${PROMPT_PLACEHOLDERS.map((p) => `{${p}}`).join(" ")}`}
          >
            <TextInput
              value={agentPrompt}
              onChangeText={setAgentPrompt}
              multiline
              placeholder={DEFAULT_AGENT_PROMPT}
              placeholderTextColor={theme.colors.foregroundMuted}
              accessibilityLabel="Agent prompt"
              style={{
                minHeight: 120,
                padding: 10,
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 6,
                color: theme.colors.foreground,
                backgroundColor: theme.colors.surface1,
                fontSize: 13,
                textAlignVertical: "top",
              }}
            />
          </SettingsRow>
          <SettingsAction
            label="Default prompt"
            actionLabel="Restore"
            disabled={agentPrompt === DEFAULT_AGENT_PROMPT}
            onPress={() => setAgentPrompt(DEFAULT_AGENT_PROMPT)}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="All tab">
        <SettingsCard>
          <SettingsInput
            label="Owners"
            hint="GitHub organizations or users, separated by commas. The All tab, before the project tabs, lists the open issues of all their repositories. Leave empty to hide it."
            placeholder="octo-org, octocat"
            initialValue={savedOwners}
            onChangeText={setOwnersText}
            error={owners ? undefined : `Use up to ${MAX_OWNERS} GitHub logins: letters, digits and hyphens`}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsCard>
        <SettingsAction
          label={saveError ? "Could not save" : "Save changes"}
          hint={saveError ?? undefined}
          actionLabel={saving ? "Saving…" : "Save"}
          disabled={saving || !changed || Boolean(prefixError) || !owners}
          onPress={() => void onSave({ ...values, branchPrefix, agent, effort, agentPrompt, owners: owners ?? [] })}
        />
      </SettingsCard>
    </>
  );
}
