// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_PROMPT, DEFAULT_PREFERENCES, type Preferences } from "../shared/issues";
import { host, readySettings, resetHost } from "./test-host";

vi.mock("@getpaseo/plugin/client", async () => (await import("./test-host")).clientModule);
vi.mock("@getpaseo/plugin/client/react-native", async () => (await import("./test-host")).reactNativeModule);
vi.mock("@getpaseo/plugin/client/ui", async () => (await import("./test-host")).uiModule);

const { SettingsScreen } = await import("./settings-screen");

const theme = {
  colors: {
    surface0: "#ffffff",
    surface1: "#f6f8fa",
    surface2: "#eaeef2",
    border: "#d0d7de",
    foreground: "#1f2328",
    foregroundMuted: "#656d76",
    accent: "#0969da",
    accentForeground: "#ffffff",
    statusSuccess: "#1a7f37",
    statusWarning: "#9a6700",
    statusDanger: "#d1242f",
  },
};

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SettingsScreen theme={theme} layout={{ compact: false, platform: "web" }} host={{ id: "srv", label: "Laptop" }} />
    </QueryClientProvider>,
  );
}

const save = () => screen.getByRole("button", { name: "Save changes: Save" });
const prefs = (overrides: Partial<Preferences> = {}): Preferences => ({ ...DEFAULT_PREFERENCES, ...overrides });

beforeEach(resetHost);
afterEach(cleanup);

describe("settings screen", () => {
  it("starts with Save disabled until something changes", () => {
    readySettings(prefs());
    renderSettings();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves the whole document, keeping values edited elsewhere", async () => {
    const saves = readySettings(prefs({ selectedRepo: "o/r", searchQuery: "label:bug", density: "compact" }));
    renderSettings();

    fireEvent.change(screen.getByLabelText("Branch prefix"), { target: { value: "fix/" } });
    fireEvent.click(save());

    await waitFor(() =>
      expect(saves).toEqual([
        prefs({ selectedRepo: "o/r", searchQuery: "label:bug", density: "compact", branchPrefix: "fix/" }),
      ]),
    );
  });

  it("saves the All tab's owners from comma-separated text", async () => {
    const saves = readySettings(prefs({ owners: ["Klartika"] }));
    renderSettings();
    const input = screen.getByLabelText("Owners") as HTMLInputElement;
    expect(input.value).toBe("Klartika");

    fireEvent.change(input, { target: { value: "Klartika, Elegia-io portico-ch" } });
    fireEvent.click(save());

    await waitFor(() => expect(saves).toEqual([prefs({ owners: ["Klartika", "Elegia-io", "portico-ch"] })]));
  });

  it("blocks saving an owner that is not a GitHub login", () => {
    readySettings(prefs());
    renderSettings();

    fireEvent.change(screen.getByLabelText("Owners"), { target: { value: "Klartika/repo" } });

    expect(screen.getByRole("alert").textContent).toMatch(/GitHub logins/);
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  it("blocks saving a branch prefix git would reject", () => {
    readySettings(prefs());
    renderSettings();

    fireEvent.change(screen.getByLabelText("Branch prefix"), { target: { value: "bad..prefix" } });

    expect(screen.getByRole("alert").textContent).toMatch(/Cannot contain/);
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists the host's ready models as agents, after Automatic", async () => {
    readySettings(prefs());
    host.providers = [
      { provider: "claude", label: "Claude", status: "ready", models: [{ id: "opus", label: "Opus" }] },
      { provider: "codex", status: "ready", enabled: false, models: [{ id: "x", label: "X" }] },
      { provider: "pi", status: "loading", models: [{ id: "y", label: "Y" }] },
    ];
    renderSettings();

    const select = screen.getByLabelText("Agent") as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(2));
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ["", "Automatic: first ready provider, default model"],
      ["claude/opus", "Claude · Opus"],
    ]);
  });

  it("keeps a saved agent the host no longer offers", async () => {
    readySettings(prefs({ agent: "gone/model" }));
    renderSettings();

    const select = screen.getByLabelText("Agent") as HTMLSelectElement;
    expect(select.value).toBe("gone/model");
  });

  it("saves the chosen agent and an edited prompt", async () => {
    const saves = readySettings(prefs());
    host.providers = [{ provider: "claude", status: "ready", models: [{ id: "opus", label: "Opus" }] }];
    renderSettings();
    const select = screen.getByLabelText("Agent") as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(2));

    fireEvent.change(select, { target: { value: "claude/opus" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Agent prompt" }), { target: { value: "Fix #{number}" } });
    fireEvent.click(save());

    await waitFor(() => expect(saves.at(-1)).toMatchObject({ agent: "claude/opus", agentPrompt: "Fix #{number}" }));
  });

  it("offers the chosen model's effort levels and saves one", async () => {
    const saves = readySettings(prefs());
    host.providers = [
      {
        provider: "claude",
        status: "ready",
        models: [
          {
            id: "opus",
            label: "Opus",
            thinkingOptions: [
              { id: "low", label: "Low" },
              { id: "max", label: "Max" },
            ],
            defaultThinkingOptionId: "low",
          },
          { id: "haiku", label: "Haiku" },
        ],
      },
    ];
    renderSettings();
    const agent = screen.getByLabelText("Agent") as HTMLSelectElement;
    await waitFor(() => expect(agent.options).toHaveLength(3));
    fireEvent.change(agent, { target: { value: "claude/opus" } });

    const effort = screen.getByLabelText("Effort") as HTMLSelectElement;
    expect([...effort.options].map((o) => [o.value, o.textContent])).toEqual([
      ["", "Model default (Low)"],
      ["low", "Low"],
      ["max", "Max"],
    ]);
    fireEvent.change(effort, { target: { value: "max" } });
    fireEvent.click(save());

    await waitFor(() => expect(saves.at(-1)).toMatchObject({ agent: "claude/opus", effort: "max" }));
  });

  it("returns the effort to the model default when the new model lacks it", async () => {
    readySettings(prefs({ agent: "claude/opus", effort: "max" }));
    host.providers = [
      {
        provider: "claude",
        status: "ready",
        models: [
          { id: "opus", label: "Opus", thinkingOptions: [{ id: "max", label: "Max" }] },
          { id: "haiku", label: "Haiku" },
        ],
      },
    ];
    renderSettings();
    const effort = screen.getByLabelText("Effort") as HTMLSelectElement;
    await waitFor(() => expect(effort.options).toHaveLength(2));
    expect(effort.value).toBe("max");

    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "claude/haiku" } });

    expect(effort.value).toBe("");
    expect([...effort.options].map((o) => o.textContent)).toEqual(["Model default"]);
  });

  it("keeps a saved effort the host no longer lists", () => {
    readySettings(prefs({ agent: "gone/model", effort: "max" }));
    renderSettings();

    expect((screen.getByLabelText("Effort") as HTMLSelectElement).value).toBe("max");
  });

  it("shows the default, with nothing to save, when a blank prompt was saved", () => {
    readySettings(prefs({ agentPrompt: "  " }));
    renderSettings();

    expect((screen.getByRole("textbox", { name: "Agent prompt" }) as HTMLTextAreaElement).value).toBe(DEFAULT_AGENT_PROMPT);
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("region", { name: "Create and start an agent" })).toBeTruthy();
  });

  it("restores the default prompt", () => {
    readySettings(prefs({ agentPrompt: "Custom" }));
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Default prompt: Restore" }));

    expect((screen.getByRole("textbox", { name: "Agent prompt" }) as HTMLTextAreaElement).value).toBe(DEFAULT_AGENT_PROMPT);
  });

  it("offers a reset when the saved document is invalid", async () => {
    readySettings(prefs());
    const reset = vi.fn(async () => true);
    host.settings = { ...host.settings!, status: "invalid", error: "expected string", reset };
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Saved settings are invalid: Reset to defaults" }));

    expect(reset).toHaveBeenCalled();
  });
});
