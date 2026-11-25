// A preview page for `bun run ui:preview src/renderer/src/work/files/FilesView.preview.tsx#FilesBrowse` (and
// #FilesNarrowSidebar, #FilesStates, #FilesGrid, #FilesColumns, #FilesGallery, #FilesBeside, #FilesDetails, #FilesSelection, #FilesHome,
// #FilesSearch, #FilesQuickLook, #FilesQuickLookText, #FilesFile, #FilesMove, #FilesSaveAsWord, #FilesGoTo, #FilesNew,
// #FilesNewLibrary, #FilesTrash, #FilesLifeosDown, #FilesWaits, #FilesSearchAcross, #FilesCopyLines, #FilesLongNames, #FilesSharedNames, #FilesSideTree, #FilesBesideConflict): the Files place's window with
// stand-in places and rows, and its states. Rendered by nothing in the app.
import type { CopyBack, FilePage, FilesHome, FileTab } from "@shared/contract-work-files";
import type { FileEntry, FilePlace } from "@shared/work/files";
import type { MenuRow } from "../../chrome/menuRows";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import type { SavedLine } from "../canvas/kind";
import type { Busy } from "./busy";
import { Facts } from "./FileKind";
import { answerAs, OverFrame, usePress, useTyped } from "../kit.preview";
import { cloudLine, copyLine, type CopyAsk, type HeaderLine } from "./fileText";
import { wordLine } from "./wordSave";
import { FileHeader } from "./FileTabView";
import { FileTextEditor } from "./FileTextEditor";
import { SIDEBAR_OVER, SidebarView } from "./FilesView";
import { SeatBar } from "./Looks";
import { ItemSkeleton } from "../canvas/ItemBones";
import { ChevronLeft } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { HomePage, SearchFilters } from "./Home";
import { MoveDialog } from "./MoveDialog";
import { sidebarOf, type FilesNote, type HostRead, type Sidebar } from "./model";
import { BarBones, ListBones, NoteEmpty, PageBar, PageView, type NoteFixes, type PageActs, type PageFind } from "./Page";
import { previewSeams } from "./previews";
import { listingSeams, type Listing } from "./store";
import { TabRow } from "./TabRow";
import { registry } from "../../lib/connection";
import { setLifeosStatus, setLifeosUnanswered } from "../shell/lifeos";

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

function Window({ width, height = 560, children, sidebarOpen = true, over = false, model = sidebar, job = workspace, open = tabs }: { width: number; height?: number; children: React.ReactNode; sidebarOpen?: boolean; over?: boolean; model?: Sidebar; job?: WorkspaceMeta; open?: FileTab[] }) {
  const side = sidebarOpen ? <SidebarView model={model} workspace={job} at={tabs[0]!.page!.at} note={null} onGo={noop} onNewTab={noop} /> : null;
  return (
    <div data-files-view style={{ maxWidth: width, height }} className="@container/files relative flex w-full overflow-hidden rounded-lg border border-border bg-background">
      {side && over ? <div className={SIDEBAR_OVER}>{side}</div> : side}
      <div className="flex min-w-0 flex-1 flex-col">
        <TabRow tabs={open} selected="t1" sidebarOpen={sidebarOpen} onSidebar={noop} onSelect={noop} onClose={noop} onReorder={noop} onNew={noop} />
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

/** Narrow, the sidebar shown by its toggle: it lies over the list under the tab row, the toggle still there to hide it. */
export function FilesNarrowSidebar() {
  return (
    <div className="flex flex-col gap-8 p-6">
      <Window width={420} over height={420}>
        <PageView {...common} listing={listing()} />
      </Window>
    </div>
  );
}

/**
 * Rows his acts are changing while the host works, each its own: a file opened from another computer saying how far it
 * has got, a rename showing the name he typed, a move, a delete and a download. Wide, then narrow with the sidebar open.
 */
export function FilesOpening() {
  const at = (name: string): string => entries.find((e) => e.name === name)!.key;
  const busy: Busy = new Map([
    [at("Sponsor deck.pptx"), { word: "Opening… 8.0 of 20 MB" }],
    [at("Sponsor list 2026.xlsx"), { word: "Renaming…", name: "Sponsor list 2027.xlsx" }],
    [at("Ballroom contract.pdf"), { word: "Moving…" }],
    [at("Stage plot.pdf"), { word: "Deleting…" }],
    [at("Vendor contacts.xlsx"), { word: "Downloading… 2.1 of 8.4 MB" }],
  ]);
  return (
    <div className="flex flex-col gap-8 p-6">
      <Window width={800} height={440}>
        <PageView {...common} busy={busy} listing={listing()} />
      </Window>
      <Window width={400} height={440}>
        <PageView {...common} busy={busy} listing={listing()} />
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
/**
 * A stand-in picture is flat grey shapes at a few strengths, so one file reads on either theme: the page is drawn
 * once, with no stylesheet to ask for a token's value, and a picture cannot read the page's own.
 */
const grey = (strength: number): string => `gray" fill-opacity="${strength}`;
function picture(kind: FileEntry["kind"], width: number): { png: string; width: number; height: number } {
  const wide = kind === "deck" || kind === "video" || kind === "picture";
  // Drawn on a 100-wide grid, as a picture a host would answer at `width`.
  const h = wide ? 56.25 : 129.4;
  const height = Math.round((width * h) / 100);
  const paper = grey(0.1);
  const ink = grey(0.75);
  const rule = grey(0.3);
  const rect = (x: number, y: number, w: number, hh: number, fill: string, more = ""): string => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="${fill}" ${more}/>`;
  const marks: string[] = [rect(0, 0, 100, h, kind === "video" ? grey(0.85) : kind === "picture" ? grey(0.18) : paper)];
  if (kind === "picture") {
    marks.push(rect(0, h * 0.62, 100, h * 0.38, grey(0.35)), `<circle cx="74" cy="${h * 0.3}" r="7" fill="${grey(0.35)}"/>`);
  } else if (kind === "video") {
    marks.push(`<path d="M44 ${h * 0.36} L60 ${h * 0.5} L44 ${h * 0.64} Z" fill="${grey(0.1)}"/>`);
  } else if (kind === "sheet") {
    marks.push(rect(6, 8, 88, 6, grey(0.2)));
    for (let y = 8; y < h - 8; y += 6) marks.push(rect(6, y, 88, 6, "none", `stroke="gray" stroke-opacity="0.3" stroke-width="0.3"`));
    for (let x = 6; x < 94; x += 22) marks.push(rect(x, 8, 22, Math.floor((h - 14) / 6) * 6, "none", `stroke="gray" stroke-opacity="0.3" stroke-width="0.3"`));
  } else if (kind === "deck") {
    marks.push(rect(0, 0, 100, h * 0.3, grey(0.45)));
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
// A text file's first lines, as its host would read them.
previewSeams.head = async () => ({ data: btoa("# Run of show\n\n4:00 PM  Doors open, check-in at the front desk\n4:30 PM  Captains meeting in room 2\n5:00 PM  Round one\n6:30 PM  Dinner break\n7:00 PM  Semifinals\n8:30 PM  Finals on the main stage\n\nBring the bracket and the spare headsets."), end: true });
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

/** Home in a narrow pane: a row opening from another computer, a held change and suggestions, each giving way to its name. */
export function FilesHomeNarrow() {
  const opening = home.recent[0]!;
  return (
    <div className="flex gap-6 p-6">
      <Window width={420} height={520}>
        <HomePage panelId="p" home={home} error={null} busy={new Map([[opening.key, { word: "Opening… 8.0 of 20 MB" }]])} onRetry={noop} onOpen={noop} bar={null} />
      </Window>
      <Window width={260} height={520} sidebarOpen={false}>
        <HomePage panelId="p" home={home} error={null} busy={new Map([[opening.key, { word: "Opening… 8.0 of 20 MB" }]])} onRetry={noop} onOpen={noop} bar={null} />
      </Window>
    </div>
  );
}

/** A search's results from every place, under its filters. */
export function FilesSearch() {
  const found = entries.filter((e) => !e.folder).slice(0, 7).map((e, i) => ({ ...e, where: i % 2 ? { place: "folder", name: "Dummy Esports", trail: ["Events"] } : { place: "b1/Events", name: "Esports Staff", trail: ["Events"] } }));
  const searchPage: FilePage = { at: { at: "place", id: "search" }, name: "Results for “sponsor”", query: "sponsor" };
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

/** Quick Look over a text file: its first lines in the mono face, read only. */
export function FilesQuickLookText() {
  const from = { workspaceId: "w", copy: eventsCopy };
  return (
    <div className="p-6">
      <Window width={980} height={680}>
        <PageView {...common} from={from} listing={listing()} drawn={{ picked: ["Run of show.md"], quick: true }} />
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
          <BarBones />
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
        <PageView {...common} listing={listing({ error: "The box did not answer. Try again once it is connected.", away: true })} />
      </Window>
      {notes.map((n) => (
        <Window key={n.name} width={720} height={300}>
          <PageView {...common} listing={null} note={n.note} />
        </Window>
      ))}
      <div style={{ maxWidth: 720 }} className="h-56 w-full rounded-lg border border-border">
        <NoteEmpty note={{ title: "No Teams files on MacBook Pro", line: "Sync a channel from Teams with OneDrive there." }} fixes={fixes} />
      </div>
    </div>
  );
}

/**
 * Files' LifeOS place while the box's LifeOS is down (council round 10): the place greyed in the sidebar, and its page
 * saying the session's state by the host's live status in the body's place, the computer named, with the one press:
 * signed out with Sign in, a sign-in waiting with Show the code, on its way with no press, the host silent with Retry.
 */
export function FilesLifeosDown() {
  Object.assign(registry, { environment: (id: string) => ({ id, name: "The box" }) });
  const states = [
    { link: "box", lifeos: "signed-out" },
    { link: "box-pairing", lifeos: "pairing" },
    { link: "box-connecting", lifeos: "connecting" },
    { link: "box-silent", lifeos: "unreachable" },
  ] as const;
  for (const { link, lifeos } of states) {
    if (link === "box-silent") setLifeosUnanswered(link);
    else setLifeosStatus(link, { lifeos: { state: lifeos, ...(lifeos === "pairing" ? { expiresAt: NOW + 10 * 60_000 } : {}) }, keys: [] } as never);
  }
  const down = (lifeos: (typeof states)[number]["lifeos"]): FilePlace["state"] => ({ state: "signed-out", detail: "LifeOS is not signed in on this host.", lifeos });
  const lifeosAt = { at: "place" as const, id: "lifeos" };
  const model = sidebarOf([{ ...reads[0]!, answer: { ...reads[0]!.answer!, places: [...reads[0]!.answer!.places, place({ id: "lifeos", kind: "lifeos", name: "LifeOS", state: down("signed-out"), can: ["make", "rename", "move", "edit"], makes: [] }), place({ id: "mail", kind: "mail", name: "From mail", state: down("signed-out") })] } }], "box");
  return (
    <div className="flex flex-col gap-8 p-6">
      {states.map(({ link, lifeos }) => {
        const copy = { place: place({ id: "lifeos", kind: "lifeos", name: "LifeOS", state: down(lifeos), can: ["make", "rename", "move", "edit"], makes: [] }), link, host: "The box", wire: "files" as const };
        return (
          <Window key={link} width={720} height={300} model={model}>
            <PageView {...common} copy={copy} acts={{ ...acts, place: copy.place, from: copy }} page={{ at: lifeosAt, name: "LifeOS" }} trail={[{ name: "LifeOS", at: lifeosAt }]} canBack={false} listing={listing({ entries: [], trail: [], error: "Not signed in to LifeOS on the box. Sign in under Settings, Connections." })} />
          </Window>
        );
      })}
    </div>
  );
}

/**
 * A read out (council round 11): Retry pressed on a folder that did not load, the failure kept with that Retry
 * spinning; a search while the box's LifeOS connects (the wait, no press, the bones) and while it is signed out (the
 * line over what came); Home while LifeOS connects, a row only LifeOS opens greyed.
 */
export function FilesWaits() {
  Object.assign(registry, { environment: (id: string) => ({ id, name: "The box" }) });
  setLifeosStatus("box-connecting", { lifeos: { state: "connecting" }, keys: [] } as never);
  setLifeosStatus("box-out", { lifeos: { state: "signed-out" }, keys: [] } as never);
  const searchPage: FilePage = { at: { at: "place", id: "search" }, name: "Results for “sponsor”", query: "sponsor" };
  const found = entries.filter((e) => !e.folder).slice(0, 3).map((e) => ({ ...e, where: { place: "b1/Events", name: "Esports Staff", trail: ["Events"] } }));
  const search = (host: string, rows: FileEntry[]) => (
    <PageView {...common} acts={null} page={searchPage} copy={null} lifeosHost={host} trail={[{ name: searchPage.name, at: searchPage.at }]} listing={listing({ entries: rows, trail: [] })} results onReveal={noop} />
  );
  const brief: FileEntry = { key: "lifeos:docs:1", ref: { at: "lifeos", table: "docs", id: "1" } as never, folder: null, name: "Sponsor brief", kind: "document", changed: NOW - 2 * day };
  return (
    <div className="flex flex-col gap-8 p-6">
      <Window width={720} height={300}>
        <PageView {...common} listing={listing({ entries: [], error: "The box did not answer. Try again once it is connected.", loading: true, retrying: true })} />
      </Window>
      <Window width={720} height={300}>
        {search("box-connecting", [])}
      </Window>
      <Window width={720} height={300}>
        {search("box-out", found)}
      </Window>
      <Window width={720} height={360}>
        <HomePage panelId="p" home={{ waiting: [], starred: [brief, home.starred[0]!], recent: home.recent.slice(0, 2) }} error={null} busy={null} lifeos={{ environmentId: "box-connecting", down: null, waits: true }} onRetry={noop} onOpen={noop} bar={<PageBar name="Home" trail={[]} find={find} canBack={false} canForward={false} onBack={noop} onForward={noop} onGo={noop} />} />
      </Window>
    </div>
  );
}

/**
 * His marks while the box's LifeOS is down or on its way (council round 12): Recent signed out and Starred connecting,
 * each with one line over the list, a LifeOS row greyed and shut, the files on disk live. A folder that did not load
 * offers no New (FilesWaits, first window).
 */
export function FilesMarksDown() {
  Object.assign(registry, { environment: (id: string) => ({ id, name: "The box" }) });
  setLifeosStatus("box-connecting", { lifeos: { state: "connecting" }, keys: [] } as never);
  setLifeosStatus("box-out", { lifeos: { state: "signed-out" }, keys: [] } as never);
  const brief: FileEntry = { key: "lifeos:docs:1", ref: { at: "lifeos", table: "docs", id: "1" } as never, folder: null, name: "Sponsor brief", kind: "document", changed: NOW - 2 * day, starred: true };
  const budget: FileEntry = { key: "lifeos:sheets:2", ref: { at: "lifeos", table: "sheets", id: "2" } as never, folder: null, name: "Season budget", kind: "sheet", changed: NOW - 3 * day };
  const files = entries.filter((e) => !e.folder).slice(0, 3);
  const lens = (id: "recent" | "starred", name: string, host: string, rows: FileEntry[]) => {
    const copy = { place: place({ id, kind: id, name }), link: host, host: "The box", wire: "files" as const };
    const at = { at: "place" as const, id };
    return <PageView {...common} copy={copy} acts={{ ...acts, place: copy.place, from: copy }} page={{ at, name }} trail={[{ name, at }]} lifeosHost={host} listing={listing({ entries: rows, trail: [] })} />;
  };
  return (
    <div className="flex flex-col gap-8 p-6">
      <Window width={720} height={300}>
        {lens("recent", "Recent", "box-out", [brief, files[0]!, budget, files[1]!])}
      </Window>
      <Window width={720} height={300}>
        {lens("starred", "Starred", "box-connecting", [brief, files[2]!])}
      </Window>
    </div>
  );
}

const saveLines: { name: string; line: SavedLine | null }[] = [
  { name: "Run of show.md", line: { state: "saved", at: NOW - 13 * 60_000 } },
  { name: "Run of show.md", line: { state: "saving" } },
  { name: "Run of show.md", line: { state: "offline", pending: 3, actions: [{ id: "retry", label: "Retry", run: noop }] } },
  { name: "Run of show.md", line: { state: "conflict", detail: "This file changed at 2:04 PM", actions: [{ id: "reload", label: "Reload", run: noop }, { id: "keep", label: "Keep Both", run: noop }] } },
  { name: "Vendor contacts.xlsx", line: { state: "copy", detail: "MacBook", actions: [{ id: "there", label: "Open on MacBook", run: noop }] } },
  { name: "Ballroom contract.pdf", line: { state: "readonly", detail: "a mail's file", actions: [{ id: "keep", label: "Save to workspace", run: noop }] } },
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
      <div style={{ maxWidth: 720 }} className="flex w-full flex-col overflow-hidden rounded-lg border border-border bg-background">
        {saveLines.map((s, i) => (
          <FileHeader key={i} name={s.name} line={s.line} where="Events" running={null} onRun={noop} onShowFolder={noop} rows={menu} onPick={noop} ask={idle} />
        ))}
      </div>
      <div style={{ maxWidth: 720 }} className="flex h-80 w-full flex-col overflow-hidden rounded-lg border border-border bg-background">
        <FileHeader name="Run of show.md" line={{ state: "saved", at: NOW - 13 * 60_000 }} where="Events" running={null} onRun={noop} onShowFolder={noop} rows={menu} onPick={noop} ask={idle} />
        <FileTextEditor name="Run of show.md" path="/w/Events/Run of show.md" readOnly={false} onChange={noop} text={"# Spring LAN: run of show\n\n- 9:00 Doors, check-in at the north desk\n- 10:00 Pools start, stations 1 to 12\n- 13:00 Lunch; the stage resets for brackets\n- 14:00 Bracket play\n- 18:30 Finals on the main stage\n\nBring: the spare router, two capture cards, gaffer tape.\n"} />
      </div>
      <div style={{ maxWidth: 720 }} className="flex h-72 w-full flex-col overflow-hidden rounded-lg border border-border bg-background">
        <FileHeader name="tournament.ts" line={{ state: "saved", at: NOW - 3 * day }} where="Tools" running={null} onRun={noop} rows={menu} onPick={noop} ask={idle} />
        <FileTextEditor name="tournament.ts" path="/w/Tools/tournament.ts" readOnly={false} onChange={noop} text={"export interface Seat {\n  station: number;\n  team: string;\n}\n\n/** Seats teams round robin across the stations. */\nexport function seat(teams: string[], stations: number): Seat[] {\n  return teams.map((team, i) => ({ station: (i % stations) + 1, team }));\n}\n"} />
      </div>
      <div style={{ maxWidth: 720 }} className="flex h-72 w-full flex-col overflow-hidden rounded-lg border border-border bg-background">
        <FileHeader name="Assets.zip" line={null} where="Events" running={null} onRun={noop} rows={menu} onPick={noop} ask={idle} />
        <Facts name="Assets.zip" entry={file("Assets.zip", "archive", 30 * day, { size: 2_400_000 })} env="box" workspaceId="w" itemId="i" source={{ at: "file", host: "env_box", path: "/w/Events/Assets.zip" }} />
      </div>
    </div>
  );
}

// ── states with a dialog, a menu or a field open ──────────────────────

// The one host the dialogs and Go to ask: the names Go to finds, and nothing else.
answerAs((method) => {
  if (method === "work.files.names") return { entries: [file("Spring LAN budget request.docx", "document", 7 * day, { where: { place: "b1/Events", name: "Esports Staff", trail: ["Events"] } }), file("Sponsor list 2026.xlsx", "sheet", 5 * day, { where: { place: "b1/Events", name: "Esports Staff", trail: ["Events"] } }), file("Spring LAN poster.png", "picture", 9 * day, { where: { place: "folder", name: "Dummy Esports", trail: ["Marketing"] } })] };
  throw new Error(`no ${method}`);
}, "box");

const eventsFolder = { at: { at: "file" as const, host: "env_box", path: TOP }, name: "Events" };

/** Move to…: the folder the file is in, its folders to go into, Move here at the foot. */
export function FilesMove() {
  return (
    <div className="p-6">
      <OverFrame maxWidth={900} height={620}>
        <Window width={900} height={620}>
          <PageView {...common} listing={listing()} drawn={{ picked: ["Sponsor deck.pptx"] }} />
        </Window>
        <MoveDialog verb="move" entries={[entries[1]!]} from={eventsCopy} start={eventsFolder} sidebar={sidebar} workspace={workspace} onPick={async () => false} onClose={noop} />
      </OverFrame>
    </div>
  );
}

/** Save as Word to…: a document of LifeOS made a .docx in a folder he picks, opened on the places. */
export function FilesSaveAsWord() {
  return (
    <div className="p-6">
      <OverFrame maxWidth={900} height={620}>
        <Window width={900} height={620}>
          <PageView {...common} listing={listing()} />
        </Window>
        <MoveDialog verb="word" entries={[]} what="Spring LAN run of show" start={null} sidebar={sidebar} workspace={workspace} onPick={async () => false} onClose={noop} />
      </OverFrame>
    </div>
  );
}

/** Go to: the field in the trail's place with "spring" typed, an open tab and the names the host found under it. */
export function FilesGoTo() {
  useTyped("[data-files-goto] input", "spring");
  return (
    <div className="p-6">
      <Window width={900} height={520}>
        <PageView {...common} find={{ ...find, mode: "goto" }} listing={listing()} />
      </Window>
    </div>
  );
}

const MENU_AT = { top: 92, right: 12 };
const folderCopy = sidebar.folder!;

/** New in the workspace's own folder: every kind it makes, From a Template…, Upload Files…, and where it is kept. */
export function FilesNew() {
  usePress("[data-files-new]");
  return (
    <div className="p-6">
      <OverFrame maxWidth={900} height={520} place={MENU_AT}>
        <Window width={900} height={520} sidebarOpen={false}>
          <PageView {...common} copy={folderCopy} acts={{ ...acts, place: folderCopy.place, from: folderCopy, fromTemplate: noop }} page={{ at: folderCopy.place.root, name: "Dummy Esports" }} trail={[{ name: "Dummy Esports", at: folderCopy.place.root }]} listing={listing()} />
        </Window>
      </OverFrame>
    </div>
  );
}

/** New in a Teams library: only what a library takes from here, a text file and a folder. */
export function FilesNewLibrary() {
  usePress("[data-files-new]");
  return (
    <div className="p-6">
      <OverFrame maxWidth={900} height={420} place={MENU_AT}>
        <Window width={900} height={420} sidebarOpen={false}>
          <PageView {...common} listing={listing()} />
        </Window>
      </OverFrame>
    </div>
  );
}

const trashCopy = sidebar.lenses.find((c) => c.place.kind === "trash")!;
const trashed: FileEntry[] = [
  file("Old sponsor deck.pptx", "deck", 2 * day, { where: { place: "b1/Events", name: "Esports Staff", trail: ["Events"] } }),
  file("Site policy draft.docx", "document", 4 * day, { ref: { at: "file", host: "env_box", path: "/vm/Site Policies/Site policy draft.docx" }, where: { place: "b2", name: "Site Policies", trail: [] } }),
  file("Notes.md", "text", 9 * day, { shared: false, where: { place: "folder", name: "Dummy Esports", trail: ["Events"] } }),
];

/** Trash: a row from a Teams library, one from the Windows VM's, one from the folder; Empty Trash in the bar. */
export function FilesTrash() {
  const page: FilePage = { at: trashCopy.place.root, name: "Trash" };
  return (
    <div className="p-6">
      <Window width={900} height={420}>
        <PageView {...common} page={page} copy={trashCopy} acts={{ ...acts, place: trashCopy.place, from: trashCopy }} trail={[{ name: "Trash", at: page.at }]} listing={listing({ entries: trashed, trail: [] })} onReveal={noop} drawn={{ picked: ["Site policy draft.docx"] }} />
      </Window>
    </div>
  );
}

/** A search's results from the box and from his Mac, and the note that the PC's folders were not searched. */
export function FilesSearchAcross() {
  const found: FileEntry[] = [
    { ...entries[1]!, where: { place: "b1/Events", name: "Esports Staff", trail: ["Events"] } },
    { ...entries[2]!, where: { place: "b1/Events", name: "Esports Staff", trail: ["Events"] } },
    file("Sponsor thank-you letter.docx", "document", 2 * day, { ref: { at: "file", host: "env_mac", path: "/Users/l/Esports/Sponsors/Sponsor thank-you letter.docx" }, where: { place: "m1", name: "Esports on MacBook", trail: ["Sponsors"] } }),
    file("Sponsor logos.zip", "archive", 11 * day, { ref: { at: "file", host: "env_mac", path: "/Users/l/Esports/Sponsors/Sponsor logos.zip" }, where: { place: "m1", name: "Esports on MacBook", trail: ["Sponsors"] } }),
  ];
  const searchPage: FilePage = { at: { at: "place", id: "search" }, name: "Results for “sponsor”", query: "sponsor" };
  return (
    <div className="p-6">
      <Window width={900} height={460}>
        <PageView {...common} acts={null} page={searchPage} copy={null} trail={[{ name: searchPage.name, at: searchPage.at }]} listing={listing({ entries: found, trail: [], unsearched: ["Purdue laptop"] })} results onReveal={noop} />
      </Window>
    </div>
  );
}

// A copy of a file on another computer that saves back: each line its header can say, with the presses the tab adds.
const back = (b: CopyBack): CopyBack => b;
const copyLines: { name: string; line: HeaderLine }[] = (
  [
    [back({ is: "ok", at: NOW - 4 * 60_000 }), {}, []],
    [back({ is: "sending" }), {}, []],
    [back({ is: "ok" }), { failed: "the disk is full." }, ["Retry"]],
    [back({ is: "changed" }), {}, ["Reload", "Keep Both"]],
    [back({ is: "gone" }), {}, ["Keep Both"]],
    [back({ is: "away" }), {}, ["Retry"]],
    [back({ is: "refused", detail: "the file is open in Word there." }), {}, ["Retry"]],
  ] as [CopyBack, CopyAsk, string[]][]
).map(([b, ask, presses]) => ({ name: "Vendor contacts.xlsx", line: { ...copyLine({ state: "saved", at: NOW - 4 * 60_000 }, b, "MacBook Pro", NOW, ask), actions: presses.map((label) => ({ id: label, label, run: noop })) } }));

// A Word file of a library opened as its document (wordSave.ts), then what OneDrive did with a save (`cloudLine`): the
// same family of lines, by the computer that holds the file, and Teams only once OneDrive has it.
const wordLines: { name: string; line: HeaderLine }[] = [
  [wordLine({ since: true, auto: true }, "Teams", "MacBook Pro", NOW), []],
  [wordLine({ since: false, auto: true, at: NOW - 3 * 60_000 }, "Teams", "MacBook Pro", NOW), []],
  [wordLine({ since: false, at: NOW - 3 * 60_000 }, "Teams", "MacBook Pro", NOW), []],
  [wordLine({ since: true, at: NOW - 3 * 60_000 }, "Teams", "MacBook Pro", NOW), ["Save to Teams as Word"]],
  [wordLine({ since: true }, "Teams", "MacBook Pro", NOW), ["Save to Teams as Word"]],
  [wordLine({ since: true, auto: true, stopped: NOW - 60_000 }, "Teams", "MacBook Pro", NOW), ["Replace", "Keep Both"]],
  [cloudLine({ state: "saved", at: NOW }, { is: "uploading", at: NOW }, "Teams", "the Windows VM", NOW), []],
  [cloudLine({ state: "saved", at: NOW }, { is: "uploaded", at: NOW - 60_000 }, "Teams", "the Windows VM", NOW), []],
  [cloudLine({ state: "saved", at: NOW }, { is: "unknown", at: NOW }, "Teams", "the Windows VM", NOW), []],
  [cloudLine({ state: "saved", at: NOW }, { is: "late", at: NOW - 120_000, why: "asleep" }, "Teams", "the Windows VM", NOW), []],
].map(([line, presses]) => ({ name: "Plan.docx", line: { ...(line as HeaderLine), actions: (presses as string[]).map((label) => ({ id: label, label, run: noop })) } }));

/** A copy's header in each of its lines: saved to the computer, saving, not saved, changed there, gone, away, refused; then a Word file's and OneDrive's. */
export function FilesCopyLines() {
  return (
    <div className="flex flex-col gap-6 p-6">
      {[copyLines, wordLines].map((lines, n) => (
        <div key={n} style={{ maxWidth: 720 }} className="flex w-full flex-col overflow-hidden rounded-lg border border-border bg-background">
          {lines.map((s, i) => (
            <FileHeader key={i} name={s.name} line={s.line} where="Events" running={null} onRun={noop} onShowFolder={noop} rows={menu} onPick={noop} ask={idle} />
          ))}
        </div>
      ))}
    </div>
  );
}

// A job and a file with long names: the trail, the rows, the sidebar and the header each have to cut them.
const LONG_JOB = "Purdue Esports Club Operations";
const LONG_FILE = "Spring LAN 2027 sponsor and vendor budget request (final, signed by Dana Lee).docx";
const longSidebar = sidebarOf([{ ...reads[0]!, answer: { ...reads[0]!.answer!, places: reads[0]!.answer!.places.map((p) => (p.kind === "folder" ? { ...p, name: LONG_JOB } : p)) } }], "box");
const longEntries = [file(LONG_FILE, "document", 2 * day, { by: "Dana Lee" }), file("Volunteer schedule for the North and South Ballrooms, Saturday and Sunday.xlsx", "sheet", 3 * day), ...entries.slice(1, 4)];
const longTrail = [{ name: LONG_JOB, at: { at: "place" as const, id: "folder" } }, { name: "Spring LAN 2027 planning and sponsor paperwork", at: { at: "file" as const, host: "env_box", path: "/w/Spring LAN 2027 planning and sponsor paperwork" } }];

/** Long names at 400px: the page with its sidebar folded, the sidebar itself, and a file's header. */
export function FilesLongNames() {
  return (
    <div className="flex flex-col gap-8 p-6">
      <Window width={400} height={360} sidebarOpen={false}>
        <PageView {...common} trail={longTrail} page={{ at: longTrail[1]!.at, name: longTrail[1]!.name }} listing={listing({ entries: longEntries })} />
      </Window>
      <Window width={400} height={420} model={longSidebar} job={{ ...workspace, name: LONG_JOB }}>
        <div />
      </Window>
      <div style={{ maxWidth: 400 }} className="flex w-full flex-col overflow-hidden rounded-lg border border-border bg-background">
        <FileHeader name={LONG_FILE} line={{ state: "saved", at: NOW - 13 * 60_000 }} where={LONG_JOB} running={null} onRun={noop} onShowFolder={noop} rows={menu} onPick={noop} ask={idle} />
        <FileHeader name={LONG_FILE} line={{ ...copyLine(null, { is: "changed" }, "MacBook Pro", NOW), actions: [{ id: "reload", label: "Reload", run: noop }, { id: "keep", label: "Keep Both", run: noop }] }} where={LONG_JOB} running={null} onRun={noop} onShowFolder={noop} rows={menu} onPick={noop} ask={idle} />
      </div>
    </div>
  );
}

// Names that share a start: his tabs, his teams, a deep folder and where found files live.
const sharedTabs: FileTab[] = [
  tabs[0]!,
  ...["Purdue Esports Spring LAN budget.xlsx", "Purdue Esports Spring LAN roster.xlsx", "Purdue Esports Spring LAN run of show.docx", "Purdue Esports Spring LAN sponsors.pptx"].map((name, i): FileTab => ({ id: `s${i}`, kind: "file", name, itemId: `si${i}`, key: `sk${i}` })),
];
const sharedSidebar = sidebarOf(
  [
    {
      ...reads[0]!,
      answer: {
        ...reads[0]!.answer!,
        places: [
          ...reads[0]!.answer!.places.filter((p) => p.kind !== "teams" && p.kind !== "onedrive"),
          lib("c1/Events", "Events", "Purdue Esports Staff", "staffevents"),
          lib("c1/General", "General", "Purdue Esports Staff", "staffgeneral"),
          lib("c2/Events", "Events", "Purdue Esports Club Officers", "clubevents"),
          lib("c2/General", "General", "Purdue Esports Club Officers", "clubgeneral"),
        ],
      },
    },
  ],
  "box",
);
const deepTrail = [
  { name: "Purdue Esports Staff", at: { at: "place" as const, id: "team:Purdue Esports Staff" } },
  { name: "Spring LAN 2027 planning", at: { at: "file" as const, host: "env_box", path: "/cloud/Staff/Events/Spring LAN 2027 planning" } },
  { name: "Vendors and contracts", at: { at: "file" as const, host: "env_box", path: "/cloud/Staff/Events/Spring LAN 2027 planning/Vendors and contracts" } },
  { name: "Ballroom", at: { at: "file" as const, host: "env_box", path: "/cloud/Staff/Events/Spring LAN 2027 planning/Vendors and contracts/Ballroom" } },
];

/** Names that share a start: the tabs keep the ends that differ, the trail gives up its parents before the folder, the sidebar's teams and a search's Where keep their ends. */
export function FilesSharedNames() {
  const found = entries.filter((e) => !e.folder).slice(0, 5).map((e, i) => ({ ...e, where: { place: "b1/Events", name: "Purdue Esports Staff", trail: i % 2 ? ["Spring LAN 2027 planning", "Ballroom"] : ["Spring LAN 2027 planning", "Sponsors"] } }));
  const searchPage: FilePage = { at: { at: "place", id: "search" }, name: "Results for “sponsor”", query: "sponsor" };
  return (
    <div className="flex flex-col gap-8 p-6">
      <Window width={720} height={240} sidebarOpen={false} open={sharedTabs}>
        <PageView {...common} trail={deepTrail} page={{ at: deepTrail[3]!.at, name: "Ballroom" }} listing={listing({ entries: entries.slice(1, 3) })} />
      </Window>
      <Window width={720} height={300} model={sharedSidebar} open={sharedTabs}>
        <div />
      </Window>
      <Window width={800} height={300} sidebarOpen={false}>
        <PageView {...common} acts={null} page={searchPage} copy={null} trail={[{ name: searchPage.name, at: searchPage.at }]} listing={listing({ entries: found, trail: [] })} results onReveal={noop} />
      </Window>
    </div>
  );
}

// The sidebar's tree over a stand-in folder (a tree of its own workspace id, which no other page asks): one folder still
// being read, one with none, one that did not load, one refused.
const sideDirs = ["Budgets", "Contracts", "Photos", "Private"].map((name): FileEntry => ({ key: `/w/${name}`, ref: null, folder: { at: "file", host: "env_box", path: `/w/${name}` }, name, kind: "folder", changed: NOW }));
const sideFetch = listingSeams.fetch!;
listingSeams.fetch = (from, at, ...rest) => {
  if (from.workspaceId !== "side") return sideFetch(from, at, ...rest);
  if (at.at !== "file") return Promise.resolve({ entries: sideDirs, trail: [] });
  if (at.path.endsWith("/Budgets")) return new Promise(() => undefined);
  if (at.path.endsWith("/Contracts")) return Promise.resolve({ entries: [file("Ballroom contract.pdf", "pdf", day)], trail: [] });
  if (at.path.endsWith("/Photos")) return Promise.reject(new Error("The box did not answer. Try again once it is connected."));
  return Promise.reject(new Error("You may not read that folder."));
};
const sideOpen = new Set(["place:folder", ...sideDirs.map((d) => d.key)]);

/** The sidebar's tree: a folder still read is one bone row, one with none says No folders, a failed read Did not load with Retry, a refused one without. */
export function FilesSideTree() {
  return (
    <div className="p-6">
      <div style={{ height: 380 }} className="flex w-fit overflow-hidden rounded-lg border border-border bg-background">
        <SidebarView model={sidebar} workspace={workspace} at={null} note={null} tree={{ workspaceId: "side", open: sideOpen, toggle: noop }} onGo={noop} onNewTab={noop} />
      </div>
    </div>
  );
}

/**
 * The Beside seat's bar on a text file he edited that changed on disk: Reload and Keep Both are both drawn, since the
 * seat has no ⋯ to hold the second. At 600 on one row; at 320, the narrowest seat beside the list, and at 400 where the
 * list and the file take turns (with the way back), the line has the first row to itself and the presses a second.
 */
export function FilesBesideConflict() {
  const conflict = { state: "conflict" as const, detail: "This file changed at 2:14 PM", actions: [{ id: "reload", label: "Reload", run: noop }, { id: "keep", label: "Keep Both", run: noop }] };
  const back = (
    <Button variant="ghost" size="icon-xs" aria-label="Back to the list" className="shrink-0 text-muted-foreground">
      <ChevronLeft />
    </Button>
  );
  return (
    <div className="flex flex-col gap-8 p-6">
      {[
        { width: 600, turns: false },
        { width: 320, turns: false },
        { width: 400, turns: true },
      ].map(({ width, turns }) => (
        <div key={width} style={{ maxWidth: width, height: 160 }} className="flex w-full flex-col overflow-hidden rounded-lg border border-border bg-background">
          <SeatBar {...(turns ? { lead: back } : {})} saved={conflict} running={null} onRun={noop} onTab={noop} />
          <ItemSkeleton />
        </div>
      ))}
    </div>
  );
}
