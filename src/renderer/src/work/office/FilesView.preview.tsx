// A preview page for `bun run ui:preview src/renderer/src/work/office/FilesView.preview.tsx#FilesStates`: the Files
// view's states when Teams files are missing, and a list with one quiet line. Rendered by nothing in the app.
import type { TeamsLibrary } from "@shared/contract-work-office";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { NoteEmpty, NoteLine, Places } from "./FilesView";
import { placeGroups, type FilesNote } from "./files";

const workspace = { id: "w", environmentId: "box", path: "/w", name: "Purdue", kind: "work" } as unknown as WorkspaceMeta;
const noop = (): void => undefined;
const lib = (over: Partial<TeamsLibrary> & Pick<TeamsLibrary, "id" | "path" | "team" | "kind">) => ({ host: "env_box", env: "box", library: null, tenant: "Purdue University", channels: [], web: null, found: true, ...over });
const groups = placeGroups(
  [
    lib({ id: "b1", vm: true, path: "C:\\Users\\tcuser\\Purdue University\\RecWell - Documents", team: "RecWell", kind: "channels", channels: ["Team RecWell", "Sport Programs", "AI Task Force"] }),
    lib({ id: "m1", host: "env_mac", env: "local", path: "/c/OneDrive-purdue.edu-RecWell-TeamRecWell", team: "RecWell-TeamRecWell", kind: "library" }),
    lib({ id: "m2", host: "env_mac", env: "local", path: "/c/OneDrive-purdue.edu", team: "My files", kind: "mine" }),
  ],
  "box",
);
const empties: { name: string; note: FilesNote }[] = [
  { name: "a: no computer allowed yet", note: { title: "This workspace can't use your computers yet", line: "Allow MacBook Pro and the Windows VM to list your Teams files.", fix: { kind: "allow", vm: true } } },
  { name: "c: OneDrive signed out in the VM", note: { title: "OneDrive on the Windows VM is signed out", fix: { kind: "sign-in", env: "box" } } },
  { name: "c: the VM not set up", note: { title: "The Windows VM is not set up", fix: { kind: "settings" } } },
  { name: "d: nothing synced on the Mac", note: { title: "No Teams files on MacBook Pro", line: "Sync a channel from Teams with OneDrive there." } },
];

export function FilesStates() {
  return (
    <div className="flex w-[720px] flex-col gap-10 p-6">
      {empties.map((e) => (
        <figure key={e.name} className="m-0 flex flex-col gap-2">
          <figcaption className="text-xs text-muted-foreground">{e.name}</figcaption>
          <div className="h-56 rounded-lg border border-border">
            <NoteEmpty note={e.note} workspace={workspace} again={noop} />
          </div>
        </figure>
      ))}
      <figure className="m-0 flex flex-col gap-2">
        <figcaption className="text-xs text-muted-foreground">Listed, one place two machines hold shown once; the VM signed out as one quiet line</figcaption>
        <div className="rounded-lg border border-border px-6 py-5">
          <Places workspace={workspace} groups={groups} />
          <NoteLine note={{ title: "OneDrive on the Windows VM is signed out", fix: { kind: "sign-in", env: "box" } }} workspace={workspace} again={noop} />
        </div>
      </figure>
    </div>
  );
}
