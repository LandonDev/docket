// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Link } from "./tcserver/store";
import type { ServerPush } from "./tcserver/types";
import { HOME_RECHECK_MS, homeNote, useRecheckWhileOffline, type SettingsHome } from "./settingsHome";
import { useThreadDefaults, workspaceStore } from "./tcserver/workspaces";
import { DEFAULT_RULES, rulesStore, useRulesScope } from "./tcserver/rules";

// The Mac's host answers `home.online` from its link to the box at that
// instant; the window's first read runs before the host has dialed the box.
class HomeLink implements Link {
  environmentId = "local";
  profile = "local" as const;
  connected = true;
  box: SettingsHome = { name: "tempcode-box", online: false };
  request<T>(method: string): Promise<T> {
    if (method === "defaults.get") return Promise.resolve({ defaults: null, overridden: false, home: this.box } as T);
    if (method === "rules.get") return Promise.resolve({ rules: DEFAULT_RULES, overridden: false, home: this.box } as T);
    if (method === "workspace.list" || method === "project.list") return Promise.resolve([] as T);
    return Promise.resolve(null as T);
  }
  onPush(_l: (push: ServerPush) => void) {
    return () => {};
  }
  onOpen(_l: () => void) {
    return () => {};
  }
  onClose() {
    return () => {};
  }
}

function Note({ home }: { home: SettingsHome | null | undefined }) {
  const { note, blocked } = homeNote(home);
  return <button disabled={blocked}>{note}</button>;
}
const DefaultsPage = () => <Note home={useThreadDefaults("local", null, true)?.home} />;
const RulesPage = () => <Note home={useRulesScope("local", null, true).scope?.home} />;

const flush = () => act(async () => {});

let link: HomeLink;
beforeEach(() => {
  link = new HomeLink();
  workspaceStore.reset();
  rulesStore.reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  workspaceStore.reset();
  rulesStore.reset();
});

describe("a settings home read before the host's link to it came up", () => {
  it("Thread defaults opened later says Saved on the box, its controls on", async () => {
    workspaceStore.attach(link);
    await flush();
    expect(workspaceStore.defaultsAt("local", null)?.home).toEqual({ name: "tempcode-box", online: false });
    link.box = { name: "tempcode-box", online: true };
    render(<DefaultsPage />);
    await flush();
    expect(screen.getByRole("button", { name: "Saved on tempcode-box" })).toHaveProperty("disabled", false);
  });

  it("Orchestration rules opened later says Saved on the box, its controls on", async () => {
    rulesStore.attach(link);
    await rulesStore.load("local", null);
    link.box = { name: "tempcode-box", online: true };
    render(<RulesPage />);
    await flush();
    expect(screen.getByRole("button", { name: "Saved on tempcode-box" })).toHaveProperty("disabled", false);
  });

  it("an open page that says offline asks again until the link is up", async () => {
    vi.useFakeTimers();
    workspaceStore.attach(link);
    rulesStore.attach(link);
    render(
      <>
        <DefaultsPage />
        <RulesPage />
      </>,
    );
    await flush();
    expect(screen.getAllByRole("button", { name: "tempcode-box is offline" })).toHaveLength(2);
    link.box = { name: "tempcode-box", online: true };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_RECHECK_MS);
    });
    expect(screen.getAllByRole("button", { name: "Saved on tempcode-box" }).map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, false]);
  });
});

describe("useRecheckWhileOffline (Add-ons and Skills ask through it too)", () => {
  function Probe({ home, recheck }: { home: SettingsHome | null; recheck: () => void }) {
    useRecheckWhileOffline(home, recheck);
    return null;
  }

  it("asks again only while the home reads offline", async () => {
    vi.useFakeTimers();
    const recheck = vi.fn();
    const { rerender } = render(<Probe home={{ name: "box", online: true }} recheck={recheck} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_RECHECK_MS * 2);
    });
    expect(recheck).not.toHaveBeenCalled();
    rerender(<Probe home={{ name: "box", online: false }} recheck={recheck} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_RECHECK_MS * 2);
    });
    expect(recheck).toHaveBeenCalledTimes(2);
    rerender(<Probe home={null} recheck={recheck} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_RECHECK_MS * 2);
    });
    expect(recheck).toHaveBeenCalledTimes(2);
  });
});
