import { useEffect, useRef } from "react";
import {
  Activity,
  AppWindow,
  Archive,
  ArrowDownLong,
  ArrowLeft,
  ArrowUpLong,
  Bot,
  BookOpen,
  Briefcase,
  Camera,
  CloudServer,
  Desktop,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  GitCompare,
  Globe,
  Inbox,
  Keyboard,
  Laptop,
  MessageMultiple,
  MessageSquarePlus,
  Moon,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  SquareMousePointer,
  Users,
  X,
  type IconComponent,
} from "./icons";
import { Button } from "../components/ui/button";
import { GroupInput, InputGroup } from "../components/ui/input";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { hostKind, type HostKind } from "../lib/hostPlatform";
import { settingsPageOf, type SettingsPageId, type SettingsSectionId, type StaticSettingsSectionId } from "../lib/settings";
import { settingsList, type ListGroup, type ListRow } from "../lib/settings/list";
import { FOCUS_SEARCH_EVENT, settingsSearch, useSettingsSearch } from "../lib/settings/searchStore";
import { useListWindow, useSettingsKnown } from "../lib/settings/useListWindow";
import { RailHeading, RailRow } from "./RailRow";
import { SectorDot } from "./WorkspaceGlyph";

export { workspaceHint } from "../lib/settings/useListWindow";

const SECTION_ICONS: Record<StaticSettingsSectionId, IconComponent> = {
  general: SlidersHorizontal,
  appearance: Palette,
  editor: FileCode,
  keybindings: Keyboard,
  updates: ArrowDownLong,
  appshots: Camera,
  computer: SquareMousePointer,
  here: MessageMultiple,
  sharing: Globe,
  publish: ArrowUpLong,
  defaults: MessageSquarePlus,
  reviews: GitCompare,
  orchestration: Bot,
  away: Moon,
  addons: Plug,
  skills: BookOpen,
  sync: RefreshCw,
  accounts: Users,
  winvm: AppWindow,
  work: Briefcase,
  digest: FileText,
  mail: Inbox,
  files: FolderOpen,
  connections: Activity,
  archive: Archive,
};

/** A computer's glyph, as the rail's own rows draw it: a laptop for a Mac, a desktop for a PC, a server for the rest. */
const COMPUTER_ICONS: Record<HostKind, IconComponent> = { mac: Laptop, pc: Desktop, server: CloudServer };

type Props = {
  section: SettingsSectionId;
  onSelect: (section: SettingsPageId) => void;
  onClose: () => void;
};

/**
 * Body of the project rail while settings are open (docs/agents/settings.md "By place"): the search field, then the
 * list's groups, each named for what a row in it changes. While something is typed no row is the current one: the
 * page shows the results.
 */
export function SettingsNav({ section, onSelect, onClose }: Props) {
  const groups = settingsList(useListWindow());
  const { addComputer } = useSettingsKnown();
  const { query } = useSettingsSearch();
  return (
    <SettingsListView
      groups={groups}
      current={query.trim() ? null : settingsPageOf(section)}
      addComputer={addComputer}
      onClose={onClose}
      onSelect={(id) => {
        settingsSearch.clear();
        onSelect(id);
      }}
    />
  );
}

/** The list as it draws, for a window: the store's (SettingsNav) or a fixture's. */
export function SettingsListView({
  groups,
  current,
  addComputer,
  onSelect,
  onClose,
}: {
  groups: readonly ListGroup[];
  current: SettingsPageId | null;
  addComputer: (() => void) | null;
  onSelect: (section: SettingsPageId) => void;
  onClose: () => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  // Archive stands last and alone: in the foot, over Back, where it reads as no workspace's neighbour.
  const last = groups.find((group) => group.id === "last");
  return (
    <>
      <SearchField />
      <div
        ref={lockOverscroll}
        aria-label="Settings"
        className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-none px-2 pb-2"
      >
        {groups
          .filter((group) => group !== last)
          .map((group, index) => (
            <div key={group.id} role="group" aria-labelledby={`settings-group-${group.id}`} className={`flex flex-col ${index === 0 ? "" : "pt-4"}`}>
              <RailHeading id={`settings-group-${group.id}`}>{group.label}</RailHeading>
              {group.rows.map((row) => (
                <ListRowView key={row.id} row={row} selected={row.id === current} onSelect={onSelect} />
              ))}
              {group.id === "others" && addComputer ? <RailRow label="Add a computer…" icon={Plus} onClick={addComputer} /> : null}
            </div>
          ))}
      </div>
      <div className="flex shrink-0 flex-col border-t border-border p-2">
        {last?.rows.map((row) => (
          <ListRowView key={row.id} row={row} selected={row.id === current} onSelect={onSelect} />
        ))}
        <RailRow label="Back" icon={ArrowLeft} onClick={onClose} />
      </div>
    </>
  );
}

function ListRowView({ row, selected, onSelect }: { row: ListRow; selected: boolean; onSelect: (id: SettingsPageId) => void }) {
  const shared = { label: row.label, trailing: row.end ?? null, selected, onClick: () => onSelect(row.id) };
  if (row.kind === "job") return <RailRow {...shared} glyph={<SectorDot sector={row.sector} />} />;
  if (row.kind === "workspace") return <RailRow {...shared} icon={Folder} />;
  if (row.kind === "computer") return <RailRow {...shared} icon={COMPUTER_ICONS[hostKind(row.platform)]} />;
  return <RailRow {...shared} icon={SECTION_ICONS[row.id as StaticSettingsSectionId]} />;
}

/**
 * "Search settings": 28px, over the list. Typing replaces the page with results; ↑ and ↓ move their highlight and
 * Enter opens it (the page's own keys, surfaces/settings/SearchResults.tsx), so the caret never leaves the field.
 */
function SearchField() {
  const { query } = useSettingsSearch();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focus = (): void => {
      field.current?.focus();
      field.current?.select();
    };
    window.addEventListener(FOCUS_SEARCH_EVENT, focus);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, focus);
  }, []);
  // Settings closed with something typed: the next open starts clean.
  useEffect(() => () => settingsSearch.clear(), []);
  return (
    <div className="shrink-0 px-2 pb-2">
      <InputGroup
        leading={<Search className="size-3.5" />}
        trailing={
          query ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear search"
              onClick={() => {
                settingsSearch.clear();
                field.current?.focus();
              }}
            >
              <X />
            </Button>
          ) : null
        }
        className="h-7 gap-1.5 rounded-md px-2"
      >
        <GroupInput
          ref={field}
          role="searchbox"
          data-settings-search=""
          aria-label="Search settings"
          placeholder="Search settings"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => settingsSearch.setQuery(event.target.value)}
          className="text-foreground"
        />
      </InputGroup>
    </div>
  );
}
