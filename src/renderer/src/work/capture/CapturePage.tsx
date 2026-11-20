import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import type { CaptureFiled, CaptureState } from "@shared/contract-work-capture";
import type { SectorKey } from "@shared/work";
import { bareKey, chordKey, modKey } from "../../lib/keys";
import type { CaptureHost } from "./client";
import { CaptureView } from "./CaptureView";
import { captureKey, choiceOfDigit, draftRefusal, stepChoice, type DraftFile, type SectorChoice } from "./draft";

/** What the page asks of main (src/preload/capture.ts). */
export interface CaptureBridge {
  hide(): void;
  failed(): void;
  size(height: number): void;
  picture(bytes: Uint8Array, type: string): Promise<string | null>;
  pathOf(file: File): string;
  onShown(fn: () => void): () => void;
  onHidden(fn: () => void): () => void;
}

const STATE_KEY = "tc.capture.state";

function cachedState(): CaptureState | null {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) ?? "null") as CaptureState | null;
  } catch {
    return null;
  }
}

const choiceOf = (last: SectorKey | null | undefined): SectorChoice => last ?? "unsorted";

interface Draft {
  text: string;
  files: DraftFile[];
  sector: SectorChoice;
}

/** A draft that came back from a failed capture, ahead of anything typed since. */
export function restored(back: Draft, now: Draft): Draft {
  return {
    text: [back.text, now.text].filter((t) => t.trim()).join("\n"),
    files: [...back.files, ...now.files],
    sector: back.sector,
  };
}

/**
 * The capture window's draft (docs/agents/work-capture.md). Return files
 * it and mod+Return files it and starts a Work thread. At the press the
 * window hides and the draft is cleared, so the next capture starts empty
 * while this one is on its way; one that fails comes back, ahead of
 * anything typed since, with the reason, and the window comes back
 * without taking the keyboard. Each press is its own capture with its own
 * key. The last state the host gave is kept, so the window is whole the
 * instant it shows; the socket opens only while it is shown or filing.
 */
export function CapturePage({ host, bridge }: { host: CaptureHost; bridge: CaptureBridge }) {
  const [state, setState] = useState<CaptureState | null>(cachedState);
  const [draft, setDraft] = useState<Draft>(() => ({ text: "", files: [], sector: choiceOf(cachedState()?.last) }));
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const touched = useRef(false);
  const inFlight = useRef(0);

  const refresh = useCallback(() => {
    host.state().then(
      (next) => {
        setState(next);
        localStorage.setItem(STATE_KEY, JSON.stringify(next));
        // The last sector leads a fresh draft; one he already pointed somewhere keeps his pick.
        if (!touched.current) setDraft((d) => ({ ...d, sector: choiceOf(next.last) }));
      },
      () => setState((s) => (s ? { ...s, connected: false } : { host: "", last: null, homes: [], connected: false })),
    );
  }, [host]);

  const settle = useCallback(() => {
    if (inFlight.current === 0) host.idle();
  }, [host]);

  useEffect(() => {
    const offShown = bridge.onShown(() => {
      field.current?.focus();
      refresh();
    });
    const offHidden = bridge.onHidden(settle);
    return () => {
      offShown();
      offHidden();
    };
  }, [bridge, refresh, settle]);

  // The window is as tall as the page: main sets its height, with no motion.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const report = () => bridge.size(Math.ceil(el.getBoundingClientRect().height));
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [bridge]);

  const refusal = draftRefusal(draft, state?.homes ?? []);
  const offline = state?.connected === false;

  const comeBack = (back: Draft, why: string) => {
    setDraft((now) => restored(back, now));
    setError(why);
    bridge.failed();
  };

  const file = (start: boolean) => {
    if (offline) return refresh();
    if (refusal !== null) {
      if (refusal) setError(refusal);
      return;
    }
    const sent = draft;
    setDraft({ text: "", files: [], sector: sent.sector });
    setError(null);
    touched.current = false;
    inFlight.current += 1;
    bridge.hide();
    host
      .file({
        key: captureKey(),
        text: sent.text,
        sector: sent.sector === "unsorted" ? null : sent.sector,
        ...(sent.files.length ? { files: sent.files.map((f) => ({ at: "file" as const, host: state?.host ?? "", path: f.path })) } : {}),
        ...(start ? { start: true } : {}),
      })
      .then(
        (filed: CaptureFiled) => {
          // Filed, but the thread he asked for did not start: say so; the task stands, so the draft stays clear.
          if (filed.threadError) {
            setError(`Filed. The thread did not start: ${filed.threadError}`);
            bridge.failed();
          }
        },
        (err: unknown) => comeBack(sent, err instanceof Error ? err.message : String(err)),
      )
      .finally(() => {
        inFlight.current -= 1;
        settle();
      });
  };

  const pick = (sector: SectorChoice) => {
    touched.current = true;
    setDraft((d) => ({ ...d, sector }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // A composition (Chinese, Japanese, a dead key) owns every key until it ends.
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      bridge.hide();
    } else if (e.key === "Enter" && !e.shiftKey && !e.altKey && (bareKey(e) || modKey(e))) {
      e.preventDefault();
      file(modKey(e));
    } else if (e.key === "Tab" && !chordKey(e)) {
      e.preventDefault();
      touched.current = true;
      const by = e.shiftKey ? -1 : 1;
      setDraft((d) => ({ ...d, sector: stepChoice(d.sector, by) }));
    } else if (modKey(e) && !e.shiftKey && !e.altKey) {
      const picked = choiceOfDigit(e.nativeEvent.code);
      if (picked) {
        e.preventDefault();
        pick(picked);
      }
    }
  };

  const addFiles = async (list: readonly File[]) => {
    const added: DraftFile[] = [];
    for (const f of list) {
      const path = bridge.pathOf(f) || (f.type.startsWith("image/") ? await bridge.picture(new Uint8Array(await f.arrayBuffer()), f.type) : null);
      if (path) added.push({ id: crypto.randomUUID(), name: path.split(/[\\/]/).pop() || f.name, path });
    }
    if (added.length) {
      setDraft((d) => ({ ...d, files: [...d.files, ...added] }));
      setError(null);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files];
    if (!pasted.length) return;
    e.preventDefault();
    void addFiles(pasted);
  };

  // Only a drag that carries files is the window's; a link or words dragged in land in the field as typed.
  const carriesFiles = (e: DragEvent<HTMLDivElement>) => [...e.dataTransfer.types].includes("Files");
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    if (!carriesFiles(e)) return;
    e.preventDefault();
    void addFiles([...e.dataTransfer.files]);
    field.current?.focus();
  };

  return (
    <div ref={root}>
      <CaptureView
        ref={field}
        text={draft.text}
        files={draft.files}
        sector={draft.sector}
        status={offline ? "offline" : "ready"}
        error={error}
        dragging={dragging}
        canFile={refusal === null}
        onText={(text) => {
          setDraft((d) => ({ ...d, text }));
          if (error) setError(null);
        }}
        onSector={(s) => {
          pick(s);
          field.current?.focus();
        }}
        onRemoveFile={(id) => setDraft((d) => ({ ...d, files: d.files.filter((f) => f.id !== id) }))}
        onFile={file}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
      />
    </div>
  );
}
