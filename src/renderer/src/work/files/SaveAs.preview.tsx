// A preview page for `bun run ui:preview src/renderer/src/work/files/SaveAs.preview.tsx#SaveAsFolder` (and
// #SaveAsPlaces): the live Save As… sheet (SaveAs.tsx `SaveAsDialog`) over a stand-in box. Rendered by nothing in the app.
import type { CanvasSource } from "@shared/work";
import type { FileEntry, FilePlace, FolderRef } from "@shared/work/files";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { registry } from "../../lib/connection";
import { answerAs, OverFrame } from "../kit.preview";
import { sidebarOf, type HostRead } from "./model";
import { previewSeams } from "./previews";
import { SaveAsDialog } from "./SaveAs";
import { tellOrigin } from "./saveAsPort";
import { listingSeams } from "./store";

const workspace = { id: "w", environmentId: "box", path: "/w", name: "Dummy Esports", kind: "work" } as unknown as WorkspaceMeta;
const TOP = "/cloud/Esports Staff/Events";
const place = (over: Partial<FilePlace> & Pick<FilePlace, "id" | "kind" | "name">): FilePlace => ({ host: "", env: "env_box", shared: over.kind === "teams", can: ["make"], makes: ["folder"], state: { state: "ok" }, root: { at: "place", id: over.id }, ...over });
const places = {
  host: "env_box",
  rev: 1,
  sources: [],
  places: [
    place({ id: "folder", kind: "folder", name: "Dummy Esports", root: { at: "file", host: "env_box", path: "/w" } }),
    place({ id: "b1/Events", kind: "teams", name: "Events", group: "Esports Staff", key: "esportsstaffevents", root: { at: "file", host: "env_box", path: TOP } }),
    place({ id: "b1/General", kind: "teams", name: "General", group: "Esports Staff", key: "esportsstaffgeneral", root: { at: "file", host: "env_box", path: "/cloud/Esports Staff/General" } }),
    place({ id: "b3", kind: "onedrive", name: "My OneDrive", key: "mine", root: { at: "file", host: "env_box", path: "/cloud/mine" } }),
  ],
};

// The box answers the sheet's asks: its places, the workspace's settings, and nothing else of note.
answerAs((method) => {
  if (method === "work.files.places") return places;
  if (method === "work.workspace.get") return { mayUseDesktop: [], windowsVm: false };
  if (method === "remote.status") return { environmentId: "box" };
  if (method === "work.office.filesCopyGet") return { on: false };
  throw new Error(`${method} is not answered here`);
}, "box");
Object.assign(registry, { has: () => true, environment: (id: string) => ({ id, name: "The box" }), environments: () => [] });

const folder = (path: string, name: string): FileEntry => ({ key: `${path}/${name}`, ref: null, folder: { at: "file", host: "env_box", path: `${path}/${name}` }, name, kind: "folder", shared: true });
listingSeams.fetch = async () => ({ entries: [folder(TOP, "Fall LAN photos"), folder(TOP, "Practice"), folder(TOP, "Sponsors")], trail: [] });
// The first page is still being drawn: its bone, in a page's shape.
previewSeams.preview = () => new Promise(() => undefined);

const read: HostRead = { link: "box", name: "The box", desktop: false, wire: "files", answer: places as never };
const events = sidebarOf([read], "box").rows.find((r) => r.name === "Events")!.copies[0]!;
const eventsAt: FolderRef = { at: "file", host: "env_box", path: TOP };

/** Save As… on a .doc opened from Teams: in its own folder, Word's format with the line that says a .doc is saved as .docx, the first page's bone, and the footer's line. */
export function SaveAsFolder() {
  tellOrigin("doc", { folder: { copy: events, at: eventsAt, name: "Events", where: "Esports Staff" }, name: "Practice register.doc" });
  const source: CanvasSource = { at: "file", host: "env_box", path: `${TOP}/Practice register.doc` } as CanvasSource;
  return (
    <div className="p-6">
      <OverFrame maxWidth={900} height={620}>
        <SaveAsDialog workspace={workspace} source={source} title="Practice register" itemId="doc" format={null} />
      </OverFrame>
    </div>
  );
}

/** Save As… on a new document with no folder yet: the places, a team over its channels one level in. */
export function SaveAsPlaces() {
  const source: CanvasSource = { at: "file", host: "env_box", path: "/w/Spring LAN run of show.tcdoc" } as CanvasSource;
  return (
    <div className="p-6">
      <OverFrame maxWidth={900} height={620}>
        <SaveAsDialog workspace={workspace} source={source} title="Spring LAN run of show" itemId="new" format={null} />
      </OverFrame>
    </div>
  );
}
