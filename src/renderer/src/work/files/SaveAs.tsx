import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CanvasSource } from "@shared/work";
import { refKey, type FileEntry } from "@shared/work/files";
import { formatForFile, formatOf, SAVE_AS_FORMATS, saveAsName, saveAsOutcome, savesLinked, type SaveAsFormat, type SavedAs } from "@shared/work/saveAs";
import { confirmChoice, DialogFooter } from "../../chrome/ConfirmDialog";
import { ChevronDown } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { Modal } from "../../chrome/Modal";
import { Tip, TruncateTip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { GroupInput, InputGroup } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { nameInLine } from "../../lib/hostWords";
import { workErrorWords } from "../../lib/workErrorWords";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { makeIn } from "./acts";
import { linkDropped } from "./fileText";
import { KindGlyph } from "./KindGlyph";
import type { Sidebar } from "./model";
import { Folders, keepRecentFolder, placeItems, Places, recentFolders, ROW, type MoveTarget } from "./MoveDialog";
import { openInFiles } from "./openFrom";
import { hostFrom, pageWidth, usePreviewPage } from "./previews";
import { NameField } from "./rowParts";
import { closeSaveAs, dropsOf, keepFormat, lastFormat, originOf } from "./saveAsPort";
import { useReach } from "./store";

/**
 * Save As… for a document (docs/agents/work-files.md "Save As…", docs/DESIGN.md "Save As…"): one sheet with the name,
 * the format and the folder, the document's first page as that format draws it, and one line that says what Save will
 * do. The folder is walked as Move to… walks it (`Places`, `Folders`), the folders he saved to last first. Saved, the
 * file stays linked to the document, which the header then says; Just a copy makes it once. A file of that name in the
 * folder asks Replace or Keep Both, never written over unasked.
 */

const NO_PLACES: Sidebar = { home: null, marks: [], lenses: [], folder: null, lifeos: null, drives: [], projects: [], places: [], rows: [] };
/**
 * Whether a failed press may still have landed: the link dropped or the far host did not answer (fileText.ts
 * `linkDropped`, and the words the host's copies.ts `unreachable` reads as no answer), not a refusal it answered.
 */
const answerUncertain = (why: string): boolean => linkDropped(why) || /offline|no live link|unreachable|not answer|ECONNRE|socket hang up/i.test(why);
const opId = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);

type Folder = MoveTarget & { where: string };

/** The document's stem as a file's name: its title with any extension of ours dropped. */
const stemOf = (title: string): string => saveAsName(title || "Untitled", "docx").replace(/\.docx$/, "");

/** The name the sheet offers first: the document's, or "<name> copy" where that is the very file it was opened from. */
export function offeredStem(stem: string, format: SaveAsFormat, own: string | undefined): string {
  return own && saveAsName(stem || "Untitled", format).toLowerCase() === own.toLowerCase() ? `${stem} copy` : stem;
}

export function SaveAsDialog({ workspace, source, title, itemId, format: asked }: { workspace: WorkspaceMeta; source: CanvasSource; title: string; itemId: string; format: SaveAsFormat | null }) {
  const reach = useReach(workspace, 0);
  const sidebar = reach?.sidebar ?? NO_PLACES;
  // The document's own file, where a Files tab knows it: the sheet opens in its folder, in its format where one is written.
  const [origin] = useState(() => originOf(itemId));
  const own = origin ? formatForFile(origin.name) : null;
  const [format, setFormat] = useState<SaveAsFormat>(() => asked ?? own?.format ?? lastFormat() ?? "docx");
  // Never the file's own path: Save As… makes another file (a Word file of Teams saves by the header's Save to Teams).
  const [stem, setStem] = useState(() => offeredStem(stemOf(title), format, origin?.name));
  const [copyOnly, setCopyOnly] = useState(false);
  // A LifeOS or Google document is exported once: a copy, with nothing to tick.
  const linkable = savesLinked(source);
  const link = linkable && !copyOnly;
  const places = placeItems(sidebar, workspace.name);
  // The folders he saved to last, as the places list them now (one no longer listed is left out).
  const recent = useMemo(() => recentFolders("saveAs", workspace), [workspace]);
  // Where the sheet stands: a folder (the place Save writes to) under the place it was reached from; null is the places.
  const [at, setAt] = useState<{ folder: MoveTarget; where: string } | null>(() =>
    origin ? { folder: origin.folder, where: origin.folder.where } : recent[0] ? { folder: recent[0], where: recent[0].where } : null,
  );
  // One press's id, kept while its words stay the same: Save again after a failure is the same press, so a file it made
  // is answered, never made twice.
  const press = useRef<{ said: string; op: string } | null>(null);
  const [naming, setNaming] = useState(false);
  const [pending, setPending] = useState(false);
  const target = at?.folder.copy;
  const far = target && !registry.has(target.link);
  const makesFolder = target?.wire === "files" && !far && target.place.makes?.includes("folder");
  const folderWhy = far ? `Make folders on ${nameInLine(target.host)}.` : null;
  // Google Drive and LifeOS make no file in a folder that a link could write again by version: there, and off.
  const off = [...sidebar.drives, ...(sidebar.lifeos ? [sidebar.lifeos] : [])].map((copy) => ({ name: copy.place.name, why: "Save As… saves to a computer's folders: the workspace's, Teams and OneDrive." }));
  const name = saveAsName(stem || "Untitled", format);
  const drops = [...(format === own?.format && own.note ? [own.note] : []), ...dropsOf(itemId, format)];
  const close = (): void => closeSaveAs();

  // `version`: with Replace, the file's version its question named; a newer file there is asked about again.
  const save = async (exists?: "replace" | "keep", version?: string): Promise<void> => {
    // Return in the Name field asks as Save does: never with no name (the host would write "Untitled").
    if (!at || pending || !stem.trim()) return;
    setPending(true);
    const asks = { workspaceId: workspace.id, source, at: at.folder.at, name, format, link, place: at.folder.name, ...(exists ? { exists } : {}), ...(exists === "replace" && version ? { version } : {}) };
    const said = JSON.stringify(asks);
    if (press.current?.said !== said) press.current = { said, op: opId() };
    try {
      const got = await registry.linkOf(workspace.environmentId).request<SavedAs>("work.files.saveAs", { ...asks, op: press.current.op }, { timeoutMs: 180_000 });
      press.current = null;
      if ("exists" in got) {
        // Asked again after his Replace: someone saved it there while he read the question, and that is said.
        const title = exists === "replace" ? `${got.exists.name} changed in ${at.folder.name} just now. Replace it?` : `Replace ${got.exists.name} in ${at.folder.name}?`;
        const choice = await confirmChoice({ title, action: "Replace", other: "Keep Both", focusOther: true });
        setPending(false);
        if (choice) await save(choice === "action" ? "replace" : "keep", got.exists.version);
        return;
      }
      keepRecentFolder("saveAs", workspace, { ...at.folder, where: at.where });
      keepFormat(format);
      // A linked file is said by the header from now on; a copy made once is said here, with the way to it.
      if (!got.saved.linked) {
        const folder = at.folder;
        void loadToast().then((toast) => toast.message(`Saved a copy of ${got.saved.name} in ${folder.name}`, { action: { label: "Show", onClick: () => void openInFiles(workspace, { page: { at: folder.at, name: folder.name } }) } }));
      }
      close();
    } catch (err) {
      // A refusal the holder answered is this press done: Save again after he clears its cause is a new one. A send
      // whose answer never came keeps its id, so the file it may have made is answered, never made twice.
      if (!answerUncertain(err instanceof Error ? err.message : String(err))) press.current = null;
      void loadToast().then((toast) => toast.error("Not saved", { description: workErrorWords(err) || undefined }));
    } finally {
      setPending(false);
    }
  };

  const formats: MenuRow[] = SAVE_AS_FORMATS.map((f) => ({ kind: "item", id: f.id, label: f.label, hint: `.${f.ext}`, checked: f.id === format }));
  const newFolder = async (typed: string | null): Promise<void> => {
    setNaming(false);
    if (!typed?.trim() || !at || !makesFolder) return;
    const made = await makeIn({ workspaceId: workspace.id, home: workspace.environmentId }, at.folder.copy, at.folder.at, "folder", typed);
    if (made?.folder) setAt({ folder: { copy: at.folder.copy, at: made.folder, name: made.name }, where: at.where });
  };

  return (
    <Modal onClose={close} title="Save As" size="lg" busy={pending} data-save-as="">
      <div className="grid min-h-0 grid-cols-1 gap-5 px-5 pt-1 pb-5 min-[620px]:grid-cols-[minmax(0,1fr)_200px]">
        <div className="grid min-w-0 grid-cols-[56px_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
          <label htmlFor="save-as-name" className="text-xs text-muted-foreground">
            Name
          </label>
          <InputGroup trailing={<span className="text-[13px] text-muted-foreground">.{formatOf(format).ext}</span>}>
            <GroupInput id="save-as-name" value={stem} spellCheck={false} onChange={(e) => setStem(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
          </InputGroup>
          <span className="text-xs text-muted-foreground">Format</span>
          <div className="flex min-w-0 items-center gap-2.5">
            <RowsMenu
              label="Format"
              rows={formats}
              onPick={(id) => setFormat(id as SaveAsFormat)}
              trigger={
                <Button variant="outline" size="sm" data-save-as-format={format} className="shrink-0 gap-1.5">
                  {formatOf(format).label}
                  <ChevronDown aria-hidden className="size-3 text-muted-foreground" />
                </Button>
              }
            />
            {drops.length > 1 ? (
              // The rest of what the format leaves out, a line each, on hover.
              <Tip label={<span className="block max-w-80 whitespace-pre-line text-left">{drops.join("\n")}</span>}>
                <span className="min-w-0 truncate text-xs text-muted-foreground">{`${drops[0]}, and ${drops.length - 1} more`}</span>
              </Tip>
            ) : drops[0] ? (
              <TruncateTip text={drops[0]}>
                <span className="min-w-0 truncate text-xs text-muted-foreground">{drops[0]}</span>
              </TruncateTip>
            ) : null}
          </div>
          <span className="self-start pt-2 text-xs text-muted-foreground">Where</span>
          <div className="flex h-[252px] min-w-0 flex-col rounded-lg border border-border px-1.5 pt-1.5">
            {at ? (
              <Folders
                key={`${at.folder.copy.link}:${JSON.stringify(at.folder.at)}`}
                workspaceId={workspace.id}
                target={at.folder}
                entries={[]}
                onInto={(folder) => setAt({ folder, where: at.where })}
                onPlaces={() => setAt(null)}
                end={makesFolder ? (
                  <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={naming} onClick={() => setNaming(true)}>
                    New Folder
                  </Button>
                ) : null}
                first={
                  naming && makesFolder ? (
                    <div className={ROW}>
                      <KindGlyph kind="folder" />
                      <NameField name="New Folder" className="h-6 flex-1 text-[13px]" onDone={(typed) => void newFolder(typed)} />
                    </div>
                  ) : null
                }
              />
            ) : (
              <Places places={places} recent={reach ? recentFolders("saveAs", workspace, places) : recent} off={off} waiting={!reach || reach.waiting} onInto={(folder) => setAt({ folder, where: "where" in folder ? (folder as Folder).where : folder.name })} />
            )}
            {folderWhy ? <p className="shrink-0 p-2 text-xs text-muted-foreground">{folderWhy}</p> : null}
          </div>
        </div>
        <FirstPage workspace={workspace} source={source} format={format} />
      </div>
      <DialogFooter
        onCancel={close}
        // Where it lands is a long line: beside Cancel and Save, never pushing them under it.
        fill
        confirmLabel="Save"
        busyLabel="Saving…"
        pending={pending}
        disabled={!at || !stem.trim()}
        start={
          linkable ? (
            <label className="flex shrink-0 items-center gap-2 text-[13px]">
              <Checkbox checked={copyOnly} onCheckedChange={(on) => setCopyOnly(on === true)} />
              Just a copy
            </label>
          ) : null
        }
        // Two lines at most, within the buttons' height: where the file will live is read whole, not cut mid-word.
        note={<Outcome words={saveAsOutcome({ name, place: at?.folder.name ?? null, link })} />}
        onConfirm={() => void save()}
      />
    </Modal>
  );
}

/**
 * Where the file will live, two lines at most within the buttons' height, read whole, never cut mid-word. A narrow
 * sheet can still cut it: then it is the whole line on hover and on focus (Tab reaches it only while cut).
 */
export function Outcome({ words }: { words: string }) {
  const [el, ref] = useState<HTMLSpanElement | null>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, words]);
  const line = (
    <span ref={ref} data-save-as-outcome tabIndex={cut ? 0 : undefined} className="line-clamp-2 min-w-0 rounded-sm text-xs leading-4 whitespace-normal text-muted-foreground">
      {words}
    </span>
  );
  if (!cut) return line;
  return (
    <Tooltip>
      <TooltipTrigger render={line} />
      <TooltipContent>
        <span className="min-w-0 break-words">{words}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/** The document's first page as the chosen format draws it: its Word file drawn on the host (LibreOffice), small. */
function FirstPage({ workspace, source, format }: { workspace: WorkspaceMeta; source: CanvasSource; format: SaveAsFormat }) {
  // One look per sheet: the page is drawn once from the live text as the sheet opens.
  const [opened] = useState(() => Date.now());
  const paged = format !== "md";
  const entry = useMemo(() => ({ key: `${refKey(source)}\u0000${opened}`, ref: source, name: "document.tcdoc", kind: "document", changed: opened, size: 0 }) as unknown as FileEntry, [source, opened]);
  const page = usePreviewPage(hostFrom(workspace.environmentId, workspace.id), entry, 1, pageWidth(168), paged);
  return (
    <div aria-hidden className="hidden min-h-0 flex-col gap-2 min-[620px]:flex">
      <div className="grid flex-1 place-items-center rounded-lg bg-(--stage) p-4">
        {!paged ? (
          <KindGlyph kind="text" className="size-8 shrink-0" />
        ) : page.is === "page" ? (
          <img alt="" src={page.url} className="w-[168px] bg-(--paper) outline-1 outline-(--image-outline)" />
        ) : page.is === "loading" ? (
          <Skeleton className="aspect-[8.5/11] w-[168px] rounded-none" />
        ) : (
          // A page that could not be drawn is the format's glyph: the picture is a glance, not a state to read.
          <KindGlyph kind={format === "pdf" ? "pdf" : "document"} className="size-8 shrink-0" />
        )}
      </div>
      <p className="h-4 text-center text-xs leading-4 text-muted-foreground">{paged && page.is === "page" && page.pages > 1 ? `Page 1 of ${page.pages}` : ""}</p>
    </div>
  );
}
