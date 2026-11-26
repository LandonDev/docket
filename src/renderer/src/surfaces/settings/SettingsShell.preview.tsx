import { useState, type ReactNode } from "react";
import { SettingsListView } from "../../chrome/SettingsRail";
import { cn } from "../../lib/cn";
import { Page } from "../../components/page";
import { settingsList, type ListWindow } from "../../lib/settings/list";
import { ADD_COMPUTER_RESULT, searchSettings } from "../../lib/settings/search";
import { settingsSearch } from "../../lib/settings/searchStore";
import type { SettingsPageId } from "../../lib/settings";
import { SearchResultsView, RESULTS_TITLE } from "./SearchResults";

/**
 * Settings' frame over fixed windows, for `bun run ui:preview
 * src/renderer/src/surfaces/settings/SettingsShell.preview.tsx#SettingsShellPreview` (the fixtures beside it): the
 * list as a Mac linked to the box and a PC draws it, as the box's web page does, and as a Mac with no other computer
 * does; with nothing typed, with results and with no match. Rendered by nothing in the app.
 */
const noop = () => {};

const JOBS = [
  { id: "j1", name: "Purdue Esports", sector: "purdue", on: "The box" },
  { id: "j2", name: "Cosmic", sector: "cosmic", on: "The box" },
  { id: "j3", name: "Hypixel", sector: "hypixel", on: "The box" },
  { id: "j4", name: "Unify", sector: "unify", on: "The box" },
  { id: "j5", name: "Referee", sector: "ref", on: "The box" },
];

export const SHELL_WINDOWS: Record<"mac" | "web" | "alone", ListWindow> = {
  mac: {
    web: false,
    platform: "darwin",
    work: true,
    has: { publish: true, winvm: true },
    computers: [
      { id: "env_box", name: "The box", platform: "linux" },
      { id: "env_pc", name: "PURDUE-LT", platform: "win32" },
    ],
    vmOn: "env_box",
    jobs: JOBS,
    workspaces: [
      { id: "w1", name: "temp-code", on: "The box" },
      { id: "w2", name: "CosmicPrisons", on: "The box" },
    ],
  },
  web: {
    web: true,
    platform: "",
    work: true,
    has: { winvm: true },
    computers: [{ id: "web", name: "The box", platform: "linux" }],
    vmOn: "web",
    jobs: JOBS.map(({ on: _on, ...job }) => job),
    workspaces: [
      { id: "w1", name: "temp-code" },
      { id: "w2", name: "CosmicPrisons" },
    ],
  },
  alone: { web: false, platform: "darwin", work: false, has: {}, computers: [], jobs: [], workspaces: [{ id: "w1", name: "temp-code" }] },
};

export function SettingsShellPreview({
  window: kind = "mac",
  current = "general",
  query = "",
  show = "window",
}: {
  window?: keyof typeof SHELL_WINDOWS;
  current?: SettingsPageId;
  query?: string;
  /** The list beside the page's place, or one of them alone (a narrow window shows one at a time). */
  show?: "window" | "list" | "page";
}) {
  useState(() => settingsSearch.setQuery(query));
  const groups = settingsList(SHELL_WINDOWS[kind]);
  // Add a computer… is found where the list offers it, as in the window.
  const results = searchSettings(query, groups, {}, kind === "web" ? [] : [ADD_COMPUTER_RESULT]);
  const searching = query.trim() !== "";
  const list = (
    // A narrow window shows the list or the page, never both: with something typed, the results.
    <nav className={cn("w-64 shrink-0 flex-col bg-sidebar pt-2 text-muted-foreground", show === "window" && searching ? "hidden @[40rem]:flex" : "flex")}>
      <SettingsListView groups={groups} current={searching ? null : current} addComputer={kind === "web" ? null : noop} onSelect={noop} onClose={noop} />
    </nav>
  );
  const page: ReactNode = searching ? (
    <Page title={RESULTS_TITLE}>
      <SearchResultsView results={results} active={0} query={query} onActive={noop} onOpen={noop} />
    </Page>
  ) : null;
  return (
    <div className="@container">
      <div className="flex min-w-0 overflow-hidden rounded-lg border border-border bg-background">
        {show === "page" ? null : list}
        {show === "list" ? null : <div className="min-w-0 flex-1 border-border @[40rem]:border-l">{page}</div>}
      </div>
    </div>
  );
}
