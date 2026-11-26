import { useEffect, useState } from "react";
import { WindowControls } from "../chrome/WindowControls";
// The rail's settings list loads with the pages (chrome/ProjectRail.tsx mounts it from this chunk).
export { SettingsNav } from "../chrome/SettingsRail";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { innerLayerOwnsEscape, usePageEscape } from "../lib/pageEscape";
import { prettyCwd } from "../lib/paths";
import { IS_MAC } from "../lib/platform";
import { modOrCtrl } from "../lib/keys";
import { computerOfSection, settingsPageOf, settingsSectionDescription, settingsSectionTitle, workspaceOfSection } from "../lib/settings";
import { useFoundRow } from "../lib/settings/reveal";
import { isHomePage } from "../lib/settings/pageHome";
import { HomeLine } from "./settings/parts/HomeLine";
import { computerInLine, useComputerName } from "../lib/settings/computerName";
import { focusSettingsSearch, settingsSearch, useSettingsSearch } from "../lib/settings/searchStore";
import { useWorkspaces } from "../lib/tcserver/workspaces";
import { AppshotsPage } from "./AppshotsSettings";
import { ReviewsPage } from "./ReviewSettings";
import { AddComputerHost } from "./settings/computers/AddComputerHost";
import { shell, useShell } from "../stores/shell";
import { PAGE_SCROLLER, Page } from "../components/page";
import { cn } from "../lib/cn";
import { DESKTOP_ONLY_LINE, isWebMode } from "../lib/nativeWeb";
import { nativePlatform } from "../lib/native";
import { Empty, EmptyTitle } from "../components/ui/empty";
import { useEnvironments } from "../lib/connection";
import { GeneralPage } from "./settings/General";
import { UpdatesPage } from "./settings/Updates";
import { ThreadDefaultsPage } from "./settings/ThreadDefaults";
import { AppearancePage } from "./settings/Appearance";
import { EditorPage } from "./settings/Editor";
import { KeybindingsPage } from "./settings/Keybindings";
import { ThreadsPage } from "./settings/computers/ThreadsPage";
import { SharingPage } from "./settings/computers/SharingPage";
import { MaySheetHost } from "./settings/computers/MaySheet";
import { ComputerLine, OtherComputerPage } from "./settings/computers/ComputerPage";
import { SyncLine, SyncPage } from "./settings/computers/SyncPage";
import { PublishPage, usePublishKnown } from "./settings/computers/PublishPage";
import { WinvmPage, useWinvmKnown } from "./settings/computers/Winvm";
import { WorkspacePage } from "./settings/Workspace";
import { OrchestrationPage } from "./settings/Orchestration";
import { ArchivePage } from "./settings/Archive";
import { AddonsPage } from "./settings/addons/AddonsPage";
import { SkillsPage } from "./settings/skills/SkillsPage";
import { ComputerPage } from "./settings/Computer";
import { WorkPage } from "./settings/Work";
import { AwayPage } from "./settings/Away";
import { AccountsFoot } from "./settings/AccountsFoot";
import { SearchResults, RESULTS_TITLE } from "./settings/SearchResults";
import { workDigestChunk, workShellChunk } from "./chunks";
import { PageEmpty, PageRowsSkeleton } from "../components/page";
import { useWorkOn } from "../lib/workSwitch";
import { defineChunk } from "../lib/lazyChunk";
import { FirstCheckBones } from "../work/connections/FirstCheckBones";
import { SurfaceSkeleton } from "./SurfaceSkeleton";

// A job's own page, and a code workspace's job, ride Work's chunk (work/shell/JobSettings.tsx).
const WorkWorkspacePage = workShellChunk.surface("WorkWorkspacePage", <PageRowsSkeleton rows={4} description control="button" />);
const CodeWorkspaceSector = workShellChunk.surface("CodeWorkspaceSector");
// Connections is a chunk of its own (work/connections): nothing of it loads until the page opens.
const connectionsChunk = defineChunk("work-connections", () => import("../work/connections/ConnectionsPage"));
// Its fallback is the page's own first-check bones, so nothing changes shape when the chunk lands.
const ConnectionsPage = connectionsChunk.surface("ConnectionsPage", <FirstCheckBones />);
// Work's own pages, each in a chunk of Work's: Digest rides the digest's, Files and Mail a chunk each (Mail loads the
// mail client only when its page opens).
const DigestPage = workDigestChunk.surface("SettingsSection", <PageRowsSkeleton rows={[{ description: true, control: "number" }, { control: "select" }, { control: "select" }, { control: "select" }, { control: "select" }]} />);
const filesPageChunk = defineChunk("work-settings-files", () => import("../work/shell/WorkPageFiles"));
const FilesPage = filesPageChunk.surface("FilesPage", <PageRowsSkeleton rows={4} description control="switch" />);
const mailPageChunk = defineChunk("work-mail-settings", () => import("../work/mail/MailSettingsSection"));
const MailPage = mailPageChunk.surface("MailPage", <PageRowsSkeleton rows={6} control="select" />);
// AI accounts is the rail's Accounts page (aliax/pages.tsx), in a chunk of its own: Settings mounts it and changes none of it.
const accountsChunk = defineChunk("settings-accounts", () => import("@aliax/pages"));
const AccountsPage = accountsChunk.surface("AccountsPage", <SurfaceSkeleton kind="accounts" label="Loading accounts" />);

type Props = {
  cwd: string;
  onOpenSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string, archived: boolean) => void;
  onDeleteSession: (sessionId: string) => void;
  onRestoreProject?: (path: string) => void;
  onDeleteProject?: (path: string) => Promise<void> | void;
  onOpenWhatsNew: (version: string, markdown?: string) => void;
};

/** A job's sector as its line says it, LifeOS's own word for it ("Purdue", "Ref"). */
const sectorWord = (sector: string): string => sector.charAt(0).toUpperCase() + sector.slice(1);

/**
 * The line under a job's or a code workspace's title: where it is. A job by its sector, a code workspace by its folder,
 * each "on" its computer as it reads mid-line (`computer`, "the box", "this Mac"); a job with no sector names its
 * computer alone.
 */
export const workspaceLine = (workspace: { kind?: string | null; path: string; sector?: string | null } | undefined, computer?: string): string | undefined => {
  if (!workspace) return "This workspace was removed.";
  const what = workspace.kind === "work" ? (workspace.sector ? sectorWord(workspace.sector) : undefined) : prettyCwd(workspace.path);
  if (!computer) return what;
  return what ? `${what}, on ${computer}` : `On ${computer}`;
};

const DesktopOnly = () => (
  <Empty>
    <EmptyTitle>{DESKTOP_ONLY_LINE}</EmptyTitle>
  </Empty>
);

/** A Mac page (Computer use) asked for in a window on another computer: the list never offers it there. */
const MacOnly = () => (
  <Empty>
    <EmptyTitle>Available on a Mac</EmptyTitle>
  </Empty>
);

/**
 * Settings' own keys, heard before the page's Escape (`usePageEscape`, declared after this in the view): ⌘F puts the
 * caret in the search field; Escape clears what is typed there, and with nothing typed and the caret in the field
 * closes Settings, so the field is one Escape from a clean list and two from the thread.
 */
function useSearchKeys(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (innerLayerOwnsEscape(event.target)) return;
      if (modOrCtrl(event) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopImmediatePropagation();
        focusSettingsSearch();
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const inField = event.target instanceof HTMLElement && event.target.hasAttribute("data-settings-search");
      if (settingsSearch.get().query) {
        event.preventDefault();
        event.stopImmediatePropagation();
        settingsSearch.clear();
      } else if (inField) {
        event.preventDefault();
        event.stopImmediatePropagation();
        shell.closeSettings();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

export function SettingsView({
  onOpenSession,
  onArchiveSession,
  onDeleteSession,
  onRestoreProject,
  onDeleteProject,
  onOpenWhatsNew,
}: Props) {
  // `cwd` stays in Props for the caller; the archive page lists every
  // project's threads from the server instead.
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const section = settingsPageOf(useShell((s) => s.settingsSection));
  const workspaceId = workspaceOfSection(section);
  const computerId = computerOfSection(section);
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  const computer = useEnvironments().find((environment) => environment.id === computerId);
  const workspaceComputer = computerInLine(useComputerName(workspace?.environmentId ?? ""));
  const platform = nativePlatform();
  const workOn = useWorkOn();
  const searching = useSettingsSearch().query.trim();
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

  useSearchKeys();
  // What only a computer knows, told to the list: where Publish can run and which computer holds the Windows VM.
  usePublishKnown();
  useWinvmKnown();
  usePageEscape(() => shell.closeSettings(), { fields: "undo" });
  useFoundRow(scroller, searching ? "" : section);

  const title = searching ? RESULTS_TITLE : workspaceId ? (workspace?.name ?? "Workspace") : computerId ? (computer?.name ?? "Computer") : settingsSectionTitle(section, platform);
  const description = searching
    ? undefined
    : workspaceId
      ? workspaceLine(workspace, workspace ? workspaceComputer : undefined)
      : computerId
        ? computer
          ? <ComputerLine environmentId={computer.id} />
          : "This window is no longer linked to that computer."
        : section === "sync"
          ? <SyncLine />
          : isHomePage(section)
            ? // An Everywhere page's line says where its one set is kept, as its store answered.
              <HomeLine page={section} />
            : settingsSectionDescription(section, platform);
  const web = isWebMode();

  return (
    <div
      role="region"
      aria-label="Settings"
      data-app-settings
      className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-border"
        data-tauri-drag-region="deep"
      >
        <div className="flex-1" />
        {IS_MAC ? null : <WindowControls />}
      </div>

      {/* Keyed by the section (a workspace's carries its id), so each page
          opens at its top; the stable gutter keeps the column still when a
          page gains a scrollbar. */}
      <div
        key={searching ? "search" : section}
        ref={(element) => {
          lockOverscroll(element);
          setScroller(element);
        }}
        className={cn(PAGE_SCROLLER, "overscroll-none", !searching && section === "accounts" ? "flex flex-col" : null)}
      >
        {searching ? (
          <Page title={title}>
            <SearchResults />
          </Page>
        ) : section === "accounts" ? (
          // The Accounts page draws its own frame (a table's width), as it does behind the rail's Accounts row.
          web ? (
            <DesktopOnly />
          ) : (
            <>
              <AccountsPage />
              <AccountsFoot />
            </>
          )
        ) : (
          <Page title={title} description={description}>
            {/* A page not yet built on PageSection renders inside one block, so the
                frame's 24px section gap never lands between its rows. */}
            {section === "general" ? <GeneralPage /> : null}
            {section === "updates" ? web ? <DesktopOnly /> : <UpdatesPage onOpenWhatsNew={onOpenWhatsNew} /> : null}
            {section === "defaults" ? <ThreadDefaultsPage /> : null}
            {workspace?.kind === "work" ? (
              <WorkWorkspacePage key={workspace.id} workspaceId={workspace.id} />
            ) : workspace ? (
              <WorkspacePage key={workspace.id} workspaceId={workspace.id} job={workOn ? <CodeWorkspaceSector workspaceId={workspace.id} /> : null} />
            ) : null}
            {section === "work" ? <WorkPage /> : null}
            {section === "winvm" ? <WinvmPage /> : null}
            {section === "digest" ? workOn ? <DigestPage /> : <PageEmpty>Work is off</PageEmpty> : null}
            {section === "mail" ? workOn ? <MailPage /> : <PageEmpty>Work is off</PageEmpty> : null}
            {section === "files" ? workOn ? <FilesPage /> : <PageEmpty>Work is off</PageEmpty> : null}
            {section === "connections" ? workOn ? <ConnectionsPage /> : <PageEmpty>Work is off</PageEmpty> : null}
            {section === "appearance" ? <AppearancePage /> : null}
            {section === "editor" ? <EditorPage /> : null}
            {section === "keybindings" ? <KeybindingsPage /> : null}
            {section === "here" ? web ? <DesktopOnly /> : <ThreadsPage onOpenSession={onOpenSession} /> : null}
            {section === "sharing" ? web ? <DesktopOnly /> : <SharingPage /> : null}
            {section === "addons" ? <AddonsPage /> : null}
            {section === "skills" ? <SkillsPage /> : null}
            {section === "orchestration" ? <OrchestrationPage /> : null}
            {section === "reviews" ? <ReviewsPage /> : null}
            {section === "away" ? <AwayPage onOpenSession={onOpenSession} /> : null}
            {section === "appshots" ? web ? <DesktopOnly /> : <AppshotsPage /> : null}
            {section === "computer" ? web ? <DesktopOnly /> : platform && platform !== "darwin" ? <MacOnly /> : <ComputerPage /> : null}
            {section === "sync" ? web ? <DesktopOnly /> : <SyncPage /> : null}
            {section === "publish" ? web ? <DesktopOnly /> : <PublishPage /> : null}
            {computer && computerId ? <OtherComputerPage key={computer.id} environmentId={computer.id} /> : null}
            {section === "archive" ? (
              <ArchivePage
                onOpenSession={onOpenSession}
                onArchiveSession={onArchiveSession}
                onDeleteSession={onDeleteSession}
                onRestoreProject={onRestoreProject}
                onDeleteProject={onDeleteProject}
              />
            ) : null}
          </Page>
        )}
      </div>
      <AddComputerHost />
      {web ? null : <MaySheetHost />}
    </div>
  );
}
