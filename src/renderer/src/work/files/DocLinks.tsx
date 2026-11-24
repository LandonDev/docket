import { useEffect, useState } from "react";
import type { CanvasSource } from "@shared/work";
import { formatOf, linkNeedsHim, linkWords, type DocLink } from "@shared/work/saveAs";
import { ChevronDown } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { Button } from "../../components/ui/button";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { workErrorWords } from "../../lib/workErrorWords";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { KindGlyph } from "./KindGlyph";
import { openSaveAs } from "./saveAsPort";
import { kindOfEntry } from "@shared/work/files";

/**
 * A document's Save As… in its header, and the files it is linked to (docs/DESIGN.md "Save As…"): the first link as one
 * quiet menu button that says where the file is and how it stands ("Saved to Esports 9:12 PM", "Saving to Esports…",
 * "Not saved to Esports yet"), with a count of the others; its menu holds each link's Open, Show in Files and Unlink,
 * and the presses a link that needs him takes (Replace, Keep Both, Save Again, Retry). The line takes the foreground
 * only when a link needs him. Read from the workspace's host, and again whenever its files say they changed.
 */

const clock = (at: number): string => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export function useDocLinks(link: string, workspaceId: string, source: CanvasSource): DocLink[] {
  const [links, setLinks] = useState<DocLink[]>([]);
  const key = JSON.stringify(source);
  useEffect(() => {
    let live = true;
    const read = (): void =>
      void registry
        .linkOf(link)
        .request<DocLink[]>("work.files.links", { workspaceId, source: JSON.parse(key) as CanvasSource })
        .then(
          (got) => live && setLinks(got),
          () => {},
        );
    read();
    const off = registry.linkOf(link).onPush((push) => {
      if (push.push === "work.files" && push.workspaceId === workspaceId && push.tabs !== undefined) read();
    });
    return () => {
      live = false;
      off();
    };
  }, [link, workspaceId, key]);
  return links;
}

type Act = "unlink" | "retry" | "replace" | "keep";

/** The presses a link takes in its state: the one he most likely wants first. */
function actsOf(l: DocLink): { act: Act; label: string }[] {
  const word = l.format === "docx";
  if (l.state === "changed") return word ? [{ act: "keep", label: "Keep Both" }, { act: "replace", label: "Replace" }] : [{ act: "replace", label: "Save Again" }];
  if (l.state === "gone") return [{ act: "keep", label: "Save Again" }];
  if (l.state === "waiting" || l.state === "refused") return [{ act: "retry", label: "Retry" }];
  return [];
}

export function DocSaveControls({ workspace, source, itemId }: { workspace: WorkspaceMeta; source: CanvasSource; itemId: string }) {
  const link = workspace.environmentId;
  const links = useDocLinks(link, workspace.id, source);
  const [busy, setBusy] = useState(false);
  const run = (l: DocLink, act: Act): void => {
    setBusy(true);
    void registry
      .linkOf(link)
      .request<DocLink[]>("work.files.linkAct", { workspaceId: workspace.id, id: l.id, act }, { timeoutMs: 180_000 })
      .catch((err: unknown) => void loadToast().then((toast) => toast.error(act === "unlink" ? "Not unlinked" : `${l.name} was not saved`, { description: workErrorWords(err) || undefined })))
      .finally(() => setBusy(false));
  };
  const open = (l: DocLink, page: boolean): void =>
    void import("./openFrom").then((m) => m.openInFiles(workspace, page ? { page: { at: l.folder, name: l.place } } : { ref: l.ref, name: l.name }));
  const first = links[0];
  const rows: MenuRow[] = links.flatMap((l, i): MenuRow[] => [
    ...(i ? ([{ kind: "sep" }] satisfies MenuRow[]) : []),
    { kind: "label", label: links.length > 1 ? `${l.name}: ${linkWords(l, clock)}` : l.name },
    ...actsOf(l).map((a): MenuRow => ({ kind: "item", id: `${a.act}:${l.id}`, label: a.label })),
    { kind: "item", id: `open:${l.id}`, label: "Open", ...(l.state === "gone" ? { disabled: true, reason: `${l.name} is not in ${l.place} any more.` } : {}) },
    { kind: "item", id: `show:${l.id}`, label: "Show in Files" },
    { kind: "item", id: `unlink:${l.id}`, label: "Unlink" },
  ]);
  const pick = (id: string): void => {
    const [act, linkId] = id.split(":") as [string, string];
    const l = links.find((x) => x.id === linkId);
    if (!l) return;
    if (act === "open") open(l, false);
    else if (act === "show") open(l, true);
    else run(l, act as Act);
  };
  const needs = links.some(linkNeedsHim);
  return (
    <>
      {first ? (
        <RowsMenu
          label="Linked files"
          align="end"
          rows={rows}
          onPick={pick}
          trigger={
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              data-doc-link={first.state}
              className={`max-w-64 min-w-0 shrink gap-1.5 font-normal ${needs ? "text-foreground" : "text-muted-foreground"}`}
            >
              <KindGlyph kind={kindOfEntry(`f.${formatOf(first.format).ext}`).kind} className="size-3.5 shrink-0" />
              <span aria-live="polite" className="min-w-0 truncate">{linkWords(needs ? (links.find(linkNeedsHim) ?? first) : first, clock)}</span>
              {links.length > 1 ? <span className="shrink-0 tabular-nums text-muted-foreground">+{links.length - 1}</span> : null}
              <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            </Button>
          }
        />
      ) : null}
      <Button variant="ghost" size="xs" data-doc-save-as className="shrink-0 text-muted-foreground" onClick={() => openSaveAs(itemId)}>
        Save As…
      </Button>
    </>
  );
}
