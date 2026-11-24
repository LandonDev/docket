import type { FilePlace, FolderRef } from "@shared/work/files";

/**
 * What New → Form offers in a place of the Files page (docs/agents/work-msforms.md "Making a form"): our own form
 * wherever the workspace lives, and a Microsoft form only in a Teams or OneDrive library of the workspace's own
 * host, when that host has the box browser's carrier (`work.msforms.list`'s `offered`). A library another computer
 * holds takes one through the workspace host's copy of the same library (`formFolderOf`); with no such copy the
 * row is there, off, with the reason as its line, and nothing is asked.
 */
export type FormKind = "microsoft" | "tempcode";

export interface FormKinds {
  kinds: FormKind[];
  /** a Microsoft form cannot be made here: the line the off row says */
  refused?: string;
}

export const ELSEWHERE_LIBRARY = "Only a library the box also holds takes a Microsoft form.";

type Copy = { place: Pick<FilePlace, "kind" | "root" | "state">; link: string };

const isLibrary = (place: Pick<FilePlace, "kind">): boolean => place.kind === "teams" || place.kind === "onedrive";

export function formKindsFor(place: Pick<FilePlace, "kind">, o: { sameHost: boolean; offered: boolean; twin?: boolean }): FormKinds {
  const library = isLibrary(place);
  if (!o.sameHost) return library && o.offered ? (o.twin ? { kinds: ["microsoft"] } : { kinds: [], refused: ELSEWHERE_LIBRARY }) : { kinds: [] };
  if (library && o.offered) return { kinds: ["microsoft", "tempcode"] };
  return { kinds: place.kind === "folder" || library ? ["tempcode"] : [] };
}

/** The copy of a place the workspace's own host holds, read or asleep, when the shown one is another computer's. */
export function twinOf<C extends Copy>(copies: readonly C[], shown: C, env: string): C | null {
  if (shown.link === env) return shown;
  return copies.find((c) => c !== shown && c.link === env && (c.place.state.state === "ok" || c.place.state.state === "asleep")) ?? null;
}

/** The folder `at` (in `shown`) as the same folder in `twin`'s copy of the library; null when `at` lies outside `shown`. */
export function formFolderOf(at: FolderRef, shown: Copy, twin: Copy): FolderRef | null {
  const from = shown.place.root;
  const to = twin.place.root;
  if (at.at !== "file" || from.at !== "file" || to.at !== "file") return null;
  if (shown === twin) return at;
  const trim = (p: string): string => p.replace(/[\\/]+$/, "");
  const top = trim(from.path);
  const path = trim(at.path);
  const fold = (p: string): string => (/^[a-zA-Z]:\\/.test(top) ? p.toLowerCase().replace(/\//g, "\\") : p);
  if (fold(path) !== fold(top) && !fold(path).startsWith(fold(top) + (/^[a-zA-Z]:\\/.test(top) ? "\\" : "/"))) return null;
  const parts = path.slice(top.length).split(/[\\/]+/).filter(Boolean);
  const sep = to.path.includes("\\") ? "\\" : "/";
  return { at: "file", host: to.host, path: [trim(to.path), ...parts].join(sep) };
}

export const FORM_KIND_WORDS: Record<FormKind, { label: string; line: string }> = {
  microsoft: { label: "Microsoft Form", line: "People sign in to answer. Answers go to a workbook in this folder." },
  tempcode: { label: "TempCode Form", line: "Anyone with the link can answer. Answers go to a sheet in Work." },
};
