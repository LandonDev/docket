import { useEffect, useMemo, useRef, useState } from "react";
import type { GoogleFileState, GoogleWritten } from "@shared/contract-work-google";
import type { CanvasItem } from "@shared/work";
import { ExternalLink, RefreshCw, X } from "../../chrome/icons";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { openUrl } from "../../lib/native";
import type { MoreEntry } from "../canvas/kind";
import { Export } from "../icons";

/**
 * A Google Doc in the document canvas (docs/agents/work-google.md "Docs"):
 * its own verbs for the pane's ⋯ (Write to Google, Read again, Drop
 * unwritten edits while there are some, Open in Google) and the minute's check that keeps the Drive version poll running
 * while it is open. When Google moves, one toast says so; the Doc is read
 * again only when he asks. `reopen` makes the canvas open the new mirror.
 */

const WATCH_MS = 60_000;

const toast = (line: string) => void loadToast().then((t) => t(line));

/** "Wrote 2 changes to Google", then what stayed, if anything did. */
export function writtenLine(done: GoogleWritten): string {
  const n = done.changed + done.added + done.removed;
  const head = n ? `Wrote ${n} ${n === 1 ? "change" : "changes"} to Google` : "Nothing new to write";
  return done.refused.length ? `${head}. Not written: ${done.refused.join("; ")}` : head;
}

export function useGoogleDoc(env: string, item: Pick<CanvasItem, "id" | "title" | "source">, reopen: () => void): MoreEntry[] {
  const google = item.source.at === "google";
  const [state, setState] = useState<GoogleFileState | null>(null);
  const said = useRef(false);

  useEffect(() => {
    if (!google) return;
    const link = registry.linkOf(env);
    let live = true;
    const take = (s: GoogleFileState) => {
      if (!live) return;
      setState(s);
      if (s.behind && !said.current) {
        said.current = true;
        toast(`${item.title} changed in Google. Read it again from ⋯.`);
      }
    };
    const ask = () => void link.request<GoogleFileState>("work.google.watch", { itemId: item.id }).then(take, () => {});
    ask();
    const timer = setInterval(ask, WATCH_MS);
    const off = link.onPush((push) => {
      if (push.push === "work.google" && push.itemId === item.id) take(push.state);
    });
    return () => {
      live = false;
      clearInterval(timer);
      off();
    };
  }, [env, google, item.id, item.title]);

  // Only the address changes the rows: the minute's check does not rebuild them.
  const url = state?.url ?? null;
  const unsent = (state?.unsent ?? 0) > 0;
  return useMemo(() => {
    if (!google) return [];
    const link = registry.linkOf(env);
    return [
      {
        id: "google-write",
        label: "Write to Google",
        icon: Export,
        async run() {
          const done = await link.request<GoogleWritten>("work.google.write", { itemId: item.id });
          toast(writtenLine(done));
        },
      },
      {
        id: "google-reload",
        label: "Read again from Google",
        icon: RefreshCw,
        async run() {
          const fresh = await link.request<GoogleFileState>("work.google.reload", { itemId: item.id });
          said.current = false;
          setState(fresh);
          reopen();
        },
      },
      // Only while he has edits Google lacks: drops them and reads the Doc as Google has it.
      ...(unsent
        ? [
            {
              id: "google-drop",
              label: "Drop unwritten edits",
              icon: X,
              async run() {
                const fresh = await link.request<GoogleFileState>("work.google.reload", { itemId: item.id, discard: true });
                said.current = false;
                setState(fresh);
                reopen();
              },
            },
          ]
        : []),
      ...(url ? [{ id: "google-open", label: "Open in Google", icon: ExternalLink, run: () => openUrl(url) }] : []),
    ];
  }, [env, google, item.id, url, unsent, reopen]);
}
