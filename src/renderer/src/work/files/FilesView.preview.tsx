// A preview page for `bun run ui:preview src/renderer/src/work/files/FilesView.preview.tsx#FilesBrowse` (and
// #FilesStates, #FilesGrid, #FilesColumns, #FilesGallery, #FilesBeside, #FilesDetails, #FilesSelection, #FilesHome,
// #FilesSearch, #FilesQuickLook, #FilesFile): the Files place's window with stand-in places and rows, and its states. Rendered by nothing in the app.
import type { FilePage, FilesHome, FileTab } from "@shared/contract-work-files";
import type { FileEntry, FilePlace } from "@shared/work/files";
import type { MenuRow } from "../../chrome/menuRows";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import type { SavedLine } from "../canvas/kind";
import { Facts } from "./FileKind";
import { FileHeader } from "./FileTabView";
import { FileTextEditor } from "./FileTextEditor";
import { SidebarView } from "./FilesView";
import { HomePage, SearchFilters } from "./Home";
import { sidebarOf, type FilesNote, type HostRead } from "./model";
import { ListBones, NoteEmpty, PageBar, PageView, type NoteFixes, type PageActs, type PageFind } from "./Page";
import { previewSeams } from "./previews";
import { listingSeams, type Listing } from "./store";
import { TabRow } from "./TabRow";

const workspace = { id: "w", environmentId: "box", path: "/w", name: "Dummy Esports", kind: "work" } as unknown as WorkspaceMeta;
const noop = (): void => undefined;
const fixes: NoteFixes = { busy: false, run: noop };
const NOW = new Date(2026, 10, 23, 14, 5).getTime();
const day = 86_400_000;

const place = (over: Partial<FilePlace> & Pick<FilePlace, "id" | "kind" | "name">): FilePlace => ({ host: "", env: "env_box", shared: over.kind === "teams" || over.kind === "onedrive", can: [], state: { state: "ok" }, root: { at: "place", id: over.id }, ...over });
const lib = (id: string, name: string, group: string, key: string, over: Partial<FilePlace> = {}): FilePlace =>
  place({ id, kind: "teams", name, group, key, root: { at: "file", host: "env_box", path: `/cloud/${group}/${name}` }, can: ["make", "rename", "move", "copy", "edit"], makes: ["text", "folder"], ...over });
const reads: HostRead[] = [
  {
    link: "box",
    name: "The box",
    desktop: false,
    wire: "files",
    answer: {
      host: "env_box",
      rev: 3,
      sources: [],
      places: [
        place({ id: "home", kind: "home", name: "Home" }),
        place({ id: "recent", kind: "recent", name: "Recent" }),
        place({ id: "starred", kind: "starred", name: "Starred" }),
        place({ id: "made", kind: "made", name: "Made by threads" }),
        place({ id: "trash", kind: "trash", name: "Trash", can: ["restore", "purge"] }),
        place({ id: "folder", kind: "folder", name: "Dummy Esports", root: { at: "file", host: "env_box", path: "/w" }, can: ["make", "upload", "rename", "move", "copy", "edit", "trash"], makes: ["document", "sheet", "deck", "text", "folder"] }),
        lib("b1/Events", "Events", "Esports Staff", "esportsstaffevents"),
        lib("b1/General", "General", "Esports Staff", "esportsstaffgeneral"),
        lib("b2", "Site Policies", "Site Policies", "sitepolicies", { state: { state: "asleep", at: NOW - 25 * 60_000 }, vm: true, host: "Windows VM" }),
        place({ id: "b3", kind: "onedrive", name: "My OneDrive", key: "mine", root: { at: "file", host: "env_box", path: "/cloud/mine" } }),
      ],
    },
  },
];
const sidebar = sidebarOf(reads, "box");

const file = (name: string, kind: FileEntry["kind"], ago: number, over: Partial<FileEntry> = {}): FileEntry => ({ key: name, ref: { at: "file", host: "env_box", path: `/cloud/Esports Staff/Events/${name}` }, folder: null, name, kind, size: 12_000, changed: NOW - ago, by: "Sam Ortiz", shared: true, ...over });
const entries: FileEntry[] = [
  { key: "Fall LAN photos", ref: null, folder: { at: "file", host: "env_box", path: "/cloud/Esports Staff/Events/Fall LAN photos" }, name: "Fall LAN photos", kind: "folder", changed: NOW - 28 * day, shared: true },
  file("Sponsor deck.pptx", "deck", 3 * day),
  file("Sponsor list 2026.xlsx", "sheet", 5 * day, { state: { is: "suggestions", count: 3 } }),
  file("Ballroom contract.pdf", "pdf", 6 * day),
  file("Spring LAN budget request.docx", "document", 7 * day, { local: false, state: { is: "cloud" } }),
  file("Stage plot.pdf", "pdf", 12 * day, { local: false, state: { is: "cloud" } }),
  file("Vendor contacts.xlsx", "sheet", 14 * day, { by: "Dana Lee", state: { is: "present", who: "Dana" } }),
  file("Risk assessment.docx", "document", 19 * day, { fresh: true, madeBy: "Venue thread" }),
  file("Walk-on music.mp3", "audio", 20 * day),
  file("Poster.png", "picture", 21 * day),
  file("Trailer v3.mp4", "video", 22 * day, { state: { is: "writing" } }),
  file("Run of show.md", "text", 26 * day),
  file("Assets.zip", "archive", 30 * day),
];
const listing = (over: Partial<Listing> = {}): Listing & { loadMore(): void; retry(): void } => ({
  entries,
  trail: [{ name: "Events", at: { at: "file", host: "env_box", path: "/cloud/Esports Staff/Events" } }],
  loaded: true,
  more: false,
  loading: false,
  error: null,
  away: false,
  loadMore: noop,
  retry: noop,
  ...over,
});
const tabs: FileTab[] = [
  { id: "t1", kind: "page", name: "Events", page: { at: { at: "file", host: "env_box", path: "/cloud/Esports Staff/Events" }, name: "Events" } },
  { id: "t2", kind: "file", name: "Nationals travel.xlsx", itemId: "i1", key: "k1" },
  { id: "t3", kind: "file", name: "Ballroom contract.pdf", itemId: "i2", key: "k2" },
];
const eventsCopy = sidebar.rows.find((r) => r.name === "Events")!.copies[0]!;
const trail = [{ name: "Esports Staff", at: { at: "place" as const, id: "team:Esports Staff" } }, { name: "Events", at: { at: "file" as const, host: "env_box", path: "/cloud/Esports Staff/Events" } }];

function Window({ width, height = 560, children, sidebarOpen = true }: { width: number; height?: number; children: React.ReactNode; sidebarOpen?: boolean }) {
  return (
    <div data-files-view style={{ width, height }} className="@container/files flex overflow-hidden rounded-lg border border-border bg-background">
      {sidebarOpen ? <SidebarView model={sidebar} workspace={workspace} at={tabs[0]!.page!.at} note={null} onGo={noop} onNewTab={noop} /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <TabRow tabs={tabs} selected="t1" sidebarOpen={sidebarOpen} onSidebar={noop} onSelect={noop} onClose={noop} onReorder={noop} onNew={noop} />
        {children}
      </div>
    </div>
  );
}

const page = tabs[0]!.page!;
// What the app gives a page: Go to and Search in its bar, and the verbs its place takes (here each does nothing).
const find: PageFind = { link: "box", workspaceId: "w", tabs, mode: null, setMode: noop, onGoTo: noop, onSearch: noop };
const acts: PageActs = {
  place: eventsCopy.place,
  from: eventsCopy,
  tabs: true,
  make: async () => null,
  rename: async () => null,
  carry: noop,
  trash: noop,
  restore: noop,
  purge: noop,
  star: noop,
  openTab: noop,
  openApp: noop,
  pickUpload: noop,
  upload: noop,
  drop: noop,
  uploading: null,
  cancelUpload: noop,
};
const common = { page, panelId: "p", copy: eventsCopy, trail, canBack: true, canForward: false, busy: null, fixes, find, acts, onBack: noop, onForward: noop, onGo: noop, onOpen: noop };

/** The window at its full width, then narrow: the sidebar folded, the columns gone from the right. */
export function FilesBrowse() {
  return (
    <div className="flex flex-col gap-8 p-6">
      <Window width={800}>
        <PageView {...common} listing={listing()} />
      </Window>
      <Window width={420} sidebarOpen={false} height={380}>
        <PageView {...common} listing={listing()} />
      </Window>
    </div>
  );
}

// Columns asks a host for each folder on the way down: here a stand-in answers, since a preview page has none.
const inFolder = (dir: string, names: [string, FileEntry["kind"]][]): FileEntry[] =>
  names.map(([name, kind], i) =>
    kind === "folder"
      ? { key: `${dir}/${name}`, ref: null, folder: { at: "file", host: "env_box", path: `${dir}/${name}` }, name, kind, changed: NOW - (i + 2) * day }
      : { key: `${dir}/${name}`, ref: { at: "file", host: "env_box", path: `${dir}/${name}` }, folder: null, name, kind, size: 48_000 * (i + 3), changed: NOW - (i + 1) * day },
  );
const TOP = "/cloud/Esports Staff/Events";
const tree: Record<string, FileEntry[]> = {
  [TOP]: entries,
  [`${TOP}/Fall LAN photos`]: inFolder(`${TOP}/Fall LAN photos`, [["Raw", "folder"], ["Crowd wide.jpg", "picture"], ["Finals stage.jpg", "picture"], ["Team photo.png", "picture"], ["Recap cut.mp4", "video"], ["Shot list.md", "text"]]),
};
listingSeams.fetch = async (_from, at) => ({ entries: at.at === "file" ? (tree[at.path] ?? []) : entries, trail: [] });
const photos: FilePage = { at: { at: "file", host: "env_box", path: `${TOP}/Fall LAN photos` }, name: "Fall LAN photos" };
const photosTrail = [...trail.slice(1), { name: "Fall LAN photos", at: photos.at }];

/** The folder as tiles, each with the file's own picture where there is one. */
export function FilesGrid() {
  const from = { workspaceId: "w", copy: eventsCopy };
  return (
    <div className="p-6">
      <Window width={900} height={600}>
        <PageView {...common} from={from} listing={listing()} drawn={{ shape: "grid", picked: ["Poster.png"] }} />
      </Window>
    </div>
  );
}

/** The folder as columns from the place's top down, the selected file's picture and facts last. */
export function FilesColumns() {
  const from = { workspaceId: "w", copy: eventsCopy };
  return (
    <div className="p-6">
      <Window width={900} height={520} sidebarOpen={false}>
        <PageView {...common} from={from} page={photos} trail={photosTrail} listing={listing({ entries: tree[photos.at.at === "file" ? photos.at.path : ""]! })} drawn={{ shape: "columns", picked: [`${TOP}/Fall LAN photos/Crowd wide.jpg`] }} />
      </Window>
    </div>
  );
}

// A preview page has no host to draw a file: each kind's picture is drawn here, plain, in the shape its host would answer.
/** A token's colour, as the theme on screen has it: a stand-in picture is drawn in the page's own colours. */
const token = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function picture(kind: FileEntry["kind"], width: number): { png: string; width: number; height: number } {
  const wide = kind === "deck" || kind === "video" || kind === "picture";
  // Drawn on a 100-wide grid, as a picture a host would answer at `width`.
  const h = wide ? 56.25 : 129.4;
  const height = Math.round((width * h) / 100);
  const paper = token("--card");
  const ink = token("--muted-foreground");
  const rule = token("--border");
  const rect = (x: number, y: number, w: number, hh: number, fill: string, more = ""): string => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="${fill}" ${more}/>`;
  const marks: string[] = [rect(0, 0, 100, h, kind === "video" ? token("--foreground") : kind === "picture" ? token("--muted") : paper)];
  if (kind === "picture") {
    marks.push(rect(0, h * 0.62, 100, h * 0.38, token("--kind-image"), 'opacity="0.5"'), `<circle cx="74" cy="${h * 0.3}" r="7" fill="${token("--kind-image")}" opacity="0.5"/>`);
  } else if (kind === "video") {
    marks.push(rect(12, h * 0.3, 76, h * 0.4, ink));
  } else if (kind === "sheet") {
    marks.push(rect(6, 8, 88, 6, token("--muted")));
    for (let y = 8; y < h - 8; y += 6) marks.push(rect(6, y, 88, 6, "none", `stroke="${rule}" stroke-width="0.3"`));
    for (let x = 6; x < 94; x += 22) marks.push(rect(x, 8, 22, Math.floor((h - 14) / 6) * 6, "none", `stroke="${rule}" stroke-width="0.3"`));
  } else if (kind === "deck") {
    marks.push(rect(0, 0, 100, h * 0.3, token("--kind-slides")));
    for (let i = 0; i < 3; i++) marks.push(rect(8, h * 0.42 + i * 7, 60 - i * 12, 2.4, rule));
  } else {
    marks.push(rect(10, 10, 46, 3.6, ink));
    for (let i = 0; i < 16; i++) marks.push(rect(10, 20 + i * 5.4, 80 - ((i * 37) % 30), 2, rule));
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 100 ${h}">${marks.join("")}</svg>`;
  return { png: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width, height };
}
previewSeams.thumbs = async (_from, list, size) => list.map((e) => (e.kind === "text" ? null : picture(e.kind, size).png));
previewSeams.preview = async (_from, entry, _page, width) => (entry.kind === "other" ? { none: "There is no preview of this file." } : { ...picture(entry.kind, Math.min(width, 1024)), pages: entry.kind === "pdf" ? 4 : 1 });
previewSeams.archive = async () => ({ entries: [{ name: "art/", size: 0, dir: true }, { name: "art/poster-final.png", size: 1_840_000, dir: false }, { name: "art/lower-third.png", size: 412_000, dir: false }, { name: "fonts/", size: 0, dir: true }, { name: "fonts/Inter.woff2", size: 148_000, dir: false }], more: false });

/** Gallery: one large read-only preview over a strip of the folder. */
export function FilesGallery() {
  const from = { workspaceId: "w", copy: eventsCopy };
  return (
    <div className="p-6">
      <Window width={900} height={620}>
        <PageView {...common} from={from} listing={listing()} drawn={{ shape: "gallery", picked: ["Ballroom contract.pdf"] }} />
      </Window>
    </div>
  );
}

/** Beside: the list in two-line rows, the selected file read only at its right. */
export function FilesBeside() {
  const from = { workspaceId: "w", copy: eventsCopy };
  return (
    <div className="p-6">
      <Window width={900} height={620} sidebarOpen={false}>
        <PageView {...common} from={from} listing={listing()} drawn={{ shape: "beside", picked: ["Sponsor deck.pptx"] }} />
      </Window>
    </div>
  );
}

/** The list under headings by kind, with the selected file's picture and facts beside it. */
export function FilesDetails() {
  const from = { workspaceId: "w", copy: eventsCopy };
  return (
    <div className="p-6">
      <Window width={980} height={620}>
        <PageView {...common} from={from} listing={listing()} drawn={{ group: "kind", details: true, picked: ["Poster.png"] }} />
      </Window>
    </div>
  );
}

/** Three things selected: the one bar that floats over the list's foot. */
export function FilesSelection() {
  return (
    <div className="p-6">
      <Window width={860} height={520}>
        <PageView {...common} listing={listing()} drawn={{ picked: ["Sponsor deck.pptx", "Sponsor list 2026.xlsx", "Ballroom contract.pdf"] }} />
      </Window>
    </div>
  );
}

const home: FilesHome = {
  waiting: [file("Sponsor list 2026.xlsx", "sheet", 5 * day, { state: { is: "suggestions", count: 3 }, where: { place: "b1/Events", name: "Esports Staff", trail: ["Events"] } }), file("Risk assessment.docx", "document", 2 * day, { held: { id: "h1", verb: "move" }, where: { place: "folder", name: "Dummy Esports", trail: [] } })],
  starred: [file("Run of show.md", "text", 26 * day, { where: { place: "folder", name: "Dummy Esports", trail: ["Events"] } }), file("Ballroom contract.pdf", "pdf", 6 * day, { where: { place: "b1/Events", name: "Esports Staff", trail: ["Events"] } })],
  recent: entries.filter((e) => !e.folder).slice(0, 6).map((e) => ({ ...e, state: undefined, where: { place: "b1/Events", name: "Esports Staff", trail: ["Events"] } })),
};

/** Home: what waits on him, his stars, what he opened last. */
export function FilesHome() {
  return (
    <div className="p-6">
      <Window width={900} height={600}>
        <HomePage panelId="p" home={home} error={null} busy={null} onRetry={noop} onOpen={noop} bar={<PageBar name="Home" trail={[]} find={find} canBack={false} canForward={false} onBack={noop} onForward={noop} onGo={noop} />} />
      </Window>
    </div>
  );
}

/** A search's results from every place, under its filters. */
export function FilesSearch() {
  const found = entries.filter((e) => !e.folder).slice(0, 7).map((e, i) => ({ ...e, where: i % 2 ? { place: "folder", name: "Dummy Esports", trail: ["Events"] } : { place: "b1/Events", name: "Esports Staff", trail: ["Events"] } }));
  const searchPage: FilePage = { at: { at: "place", id: "search" }, name: "Search: sponsor", query: "sponsor" };
  return (
    <div className="p-6">
      <Window width={900} height={560}>
        <PageView
          {...common}
          acts={null}
          page={searchPage}
          copy={null}
          trail={[{ name: searchPage.name, at: searchPage.at }]}
          listing={listing({ entries: found, trail: [] })}
          results
          onReveal={noop}
          under={<SearchFilters filter={{ kinds: ["sheet", "pdf"], within: "month" }} choices={{ places: [], projects: [] }} saved={false} onFilter={noop} onSave={noop} onRemove={noop} />}
        />
      </Window>
    </div>
  );
}

/** Quick Look over a folder: the layer with a PDF's pages, read only. */
export function FilesQuickLook() {
  const from = { workspaceId: "w", copy: eventsCopy };
  return (
    <div className="p-6">
      <Window width={980} height={680}>
        <PageView {...common} from={from} listing={listing()} drawn={{ picked: ["Ballroom contract.pdf"], quick: true }} />
      </Window>
    </div>
  );
}

const notes: { name: string; note: FilesNote }[] = [
  { name: "No computer allowed yet", note: { title: "This workspace can't use your computers yet", line: "Allow MacBook Pro and the Windows VM to list your Teams files.", fix: { kind: "allow", vm: true } } },
  { name: "OneDrive signed out in the VM", note: { title: "OneDrive on the Windows VM is signed out", fix: { kind: "sign-in", link: "box" } } },
];

/** Each state a page can be in: loading, empty, failed, a machine asleep over the list it kept, a machine away, and the notes that stand where a list would. */
export function FilesStates() {
  const asleep = sidebar.rows.find((r) => r.name === "Site Policies")!.copies[0]!;
  return (
    <div className="flex flex-col gap-8 p-6">
      <Window width={720} height={300}>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="h-11 shrink-0 border-b border-border" />
          <ListBones />
        </div>
      </Window>
      <Window width={720} height={300}>
        <PageView {...common} listing={listing({ entries: [] })} />
      </Window>
      <Window width={720} height={300}>
        <PageView {...common} listing={listing({ entries: [], error: "That folder is not there any more." })} />
      </Window>
      <Window width={720} height={300}>
        <PageView {...common} copy={asleep} listing={listing({ asOf: NOW - 25 * 60_000 })} />
      </Window>
      <Window width={720} height={300}>
        <PageView {...common} listing={listing({ error: "No answer in 4 s", away: true })} />
      </Window>
      {notes.map((n) => (
        <Window key={n.name} width={720} height={300}>
          <PageView {...common} listing={null} note={n.note} />
        </Window>
      ))}
      <div className="h-56 w-[720px] rounded-lg border border-border">
        <NoteEmpty note={{ title: "No Teams files on MacBook Pro", line: "Sync a channel from Teams with OneDrive there." }} fixes={fixes} />
      </div>
    </div>
  );
}

const saveLines: { name: string; line: SavedLine | null }[] = [
  { name: "Run of show.md", line: { state: "saved", at: NOW - 13 * 60_000 } },
  { name: "Run of show.md", line: { state: "saving" } },
  { name: "Run of show.md", line: { state: "offline", pending: 3, actions: [{ id: "retry", label: "Retry", run: noop }] } },
  { name: "Run of show.md", line: { state: "conflict", detail: "This file changed at 2:04 PM", actions: [{ id: "reload", label: "Reload", run: noop }, { id: "keep", label: "Keep mine as a copy", run: noop }] } },
  { name: "Vendor contacts.xlsx", line: { state: "copy", detail: "MacBook", actions: [{ id: "there", label: "Open on MacBook", run: noop }] } },
  { name: "Ballroom contract.pdf", line: { state: "readonly", detail: "a mail's file", actions: [{ id: "keep", label: "Keep", run: noop }] } },
  { name: "Stage plot.pdf", line: { state: "downloading", detail: "2.1 of 8.4 MB" } },
  { name: "Site policy.docx", line: { state: "asleep", detail: "The Windows VM", at: NOW - 25 * 60_000, actions: [{ id: "wake", label: "Wake it", run: noop }] } },
  { name: "Assets.zip", line: null },
];
const menu: MenuRow[] = [{ kind: "item", id: "close", label: "Close Tab" }];
const idle = { disabled: false, pressed: false, run: noop };

/** A file open as itself: its header in each state of the save line, a text file in its editor, and a file's facts. */
export function FilesFile() {
  return (
    <div className="flex flex-col gap-8 p-6">
      <div className="flex w-[720px] flex-col overflow-hidden rounded-lg border border-border bg-background">
        {saveLines.map((s, i) => (
          <FileHeader key={i} name={s.name} line={s.line} where="Events" running={null} onRun={noop} onShowFolder={noop} rows={menu} onPick={noop} ask={idle} />
        ))}
      </div>
      <div className="flex h-80 w-[720px] flex-col overflow-hidden rounded-lg border border-border bg-background">
        <FileHeader name="Run of show.md" line={{ state: "saved", at: NOW - 13 * 60_000 }} where="Events" running={null} onRun={noop} onShowFolder={noop} rows={menu} onPick={noop} ask={idle} />
        <FileTextEditor name="Run of show.md" path="/w/Events/Run of show.md" readOnly={false} onChange={noop} text={"# Spring LAN: run of show\n\n- 9:00 Doors, check-in at the north desk\n- 10:00 Pools start, stations 1 to 12\n- 13:00 Lunch; the stage resets for brackets\n- 14:00 Bracket play\n- 18:30 Finals on the main stage\n\nBring: the spare router, two capture cards, gaffer tape.\n"} />
      </div>
      <div className="flex h-72 w-[720px] flex-col overflow-hidden rounded-lg border border-border bg-background">
        <FileHeader name="tournament.ts" line={{ state: "saved", at: NOW - 3 * day }} where="Tools" running={null} onRun={noop} rows={menu} onPick={noop} ask={idle} />
        <FileTextEditor name="tournament.ts" path="/w/Tools/tournament.ts" readOnly={false} onChange={noop} text={"export interface Seat {\n  station: number;\n  team: string;\n}\n\n/** Seats teams round robin across the stations. */\nexport function seat(teams: string[], stations: number): Seat[] {\n  return teams.map((team, i) => ({ station: (i % stations) + 1, team }));\n}\n"} />
      </div>
      <div className="flex h-72 w-[720px] flex-col overflow-hidden rounded-lg border border-border bg-background">
        <FileHeader name="Assets.zip" line={null} where="Events" running={null} onRun={noop} rows={menu} onPick={noop} ask={idle} />
        <Facts name="Assets.zip" entry={file("Assets.zip", "archive", 30 * day, { size: 2_400_000 })} env="box" workspaceId="w" itemId="i" source={{ at: "file", host: "env_box", path: "/w/Events/Assets.zip" }} />
      </div>
    </div>
  );
}
