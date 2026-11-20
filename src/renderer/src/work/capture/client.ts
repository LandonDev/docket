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
}

export function captureHost(port: () => Promise<number | null>, make = (url: string) => new Transport(url, "local")): CaptureHost {
  let open: Promise<Transport> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

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
