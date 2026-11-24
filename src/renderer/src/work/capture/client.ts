import type { CaptureFiled, CaptureFileParams, CaptureState } from "@shared/contract-work-capture";
import { Transport } from "../../lib/connection/transport";

/**
 * The capture window's one socket to this computer's own host
 * (src/main/capture.ts asks main for the port). It opens when the window
 * shows and closes a minute after it hides, so a hidden window is not one
 * more socket every push goes to.
 */
const IDLE_CLOSE_MS = 60_000;

export interface CaptureHost {
  state(): Promise<CaptureState>;
  file(params: CaptureFileParams): Promise<CaptureFiled>;
  /** the window hid: close the socket once it has been idle a while */
  idle(): void;
  /**
   * This host's LifeOS status changed (its `work.lifeos` push, which goes to every client socket): heard while the
   * socket is open, that is while the window shows and a minute after. Returns the unsubscribe.
   */
  onLifeos(fn: () => void): () => void;
}

export function captureHost(port: () => Promise<number | null>, make = (url: string) => new Transport(url, "local")): CaptureHost {
  let open: Promise<Transport> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const lifeos = new Set<() => void>();

  const link = (): Promise<Transport> => {
    if (timer) clearTimeout(timer);
    timer = null;
    open ??= (async () => {
      const p = await port();
      if (!p) throw new Error("TempCode's host is not running.");
      const t = make(`ws://127.0.0.1:${p}`);
      t.onClose(() => {
        open = null;
      });
      t.onPush((push) => {
        if (push.push === "work.lifeos") for (const fn of lifeos) fn();
      });
      await t.open();
      return t;
    })().catch((err: unknown) => {
      open = null;
      throw err;
    });
    return open;
  };

  return {
    state: async () => (await link()).request<CaptureState>("work.capture.state", {}),
    file: async (params) => (await link()).request<CaptureFiled>("work.capture.file", params, { lane: "ui" }),
    onLifeos(fn) {
      lifeos.add(fn);
      return () => void lifeos.delete(fn);
    },
    idle() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const was = open;
        open = null;
        void was?.then((t) => t.close({ kind: "local", message: "idle" }), () => undefined);
      }, IDLE_CLOSE_MS);
    },
  };
}
