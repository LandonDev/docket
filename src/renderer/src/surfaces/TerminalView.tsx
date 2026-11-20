import { macCommand, modOrCtrl } from "../lib/keys";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { frameLoopAllowed, usePaneVisible } from "../hooks/paneVisibility";
import {
  getPtyStatus,
  killPty,
  resizePty,
  spawnPty,
  subscribePty,
  writePty,
} from "../lib/pty";
import { isOscColorQuery, oscColorReply } from "../lib/terminalChrome";
import {
  defaultTerminalTitle,
  scanOscCwd,
  type TerminalMetaPatch,
} from "../lib/terminalTab";
import { isLightScheme, SCHEME_CHANGE_EVENT } from "../lib/appearance";
import { ANSI, MINIMUM_CONTRAST, TERMINAL_DARK, TERMINAL_FALLBACK } from "../lib/terminalPalette";
import {
  applyTerminalChrome,
  fitTerminal,
  resetGridStretch,
  type TerminalFitMode,
} from "../lib/terminalLayout";
import { IS_MAC } from "../lib/platform";
import { DESKTOP_ONLY_LINE, isWebMode } from "../lib/nativeWeb";
import { Empty, EmptyTitle } from "../components/ui/empty";
import "@xterm/xterm/css/xterm.css";

// The Dev servers pane and its read-only console ride the same chunk as the shell (xterm).
export { DevServersPane } from "./DevServersPane";

type Props = {
  id: string;
  cwd: string;
  active: boolean;
  onMetaChange?: (patch: TerminalMetaPatch) => void;
};

function cssColor(expr: string, fallback: string): string {
  const probe = document.createElement("span");
  probe.style.color = expr;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color || fallback;
}

/** xterm's three slider colours, each the scrollbar token of that state. */
export const TERMINAL_SCROLLBAR_TOKENS = {
  scrollbarSliderBackground: "--scrollbar-thumb",
  scrollbarSliderHoverBackground: "--scrollbar-thumb-hover",
  scrollbarSliderActiveBackground: "--scrollbar-thumb-active",
} as const;

function terminalScrollbar(): Record<keyof typeof TERMINAL_SCROLLBAR_TOKENS, string> {
  const entries = Object.entries(TERMINAL_SCROLLBAR_TOKENS).map(([key, token]) => [key, cssColor(`var(${token})`, "transparent")]);
  return Object.fromEntries(entries) as Record<keyof typeof TERMINAL_SCROLLBAR_TOKENS, string>;
}

export function terminalTheme(light: boolean) {
  const fallback = light ? TERMINAL_FALLBACK.light : TERMINAL_FALLBACK.dark;
  const foreground = cssColor("var(--color-foreground)", fallback.foreground);
  const ink = hexOf(foreground, fallback.foreground);
  const ground = hexOf(cssColor("var(--color-background)", fallback.background), fallback.background);
  // The pane paints the ground. In light xterm is told its colour at zero alpha, so reverse video
  // and the contrast floor (MINIMUM_CONTRAST) work from the colour on screen, not from black; the
  // cursor's cut-out is the ground and a selection the ink at 18% (8% unfocused). Dark keeps the
  // four values it had.
  const own = light ? { background: `${ground}00`, cursorAccent: ground, selectionBackground: `${ink}2e`, selectionInactiveBackground: `${ink}14` } : TERMINAL_DARK;
  return {
    ...own,
    foreground,
    cursor: cssColor("var(--color-accent)", fallback.accent),
    // The app's scrollbar tokens (docs/DESIGN.md "Scrolling"); index.css sizes the bar.
    ...terminalScrollbar(),
    ...(light ? ANSI.light : ANSI.dark),
  };
}

/** What a terminal takes from the scheme, at birth and on every change: its
 *  colours, and the floor a program's own colours are held to. */
export function terminalScheme(light = isLightScheme()) {
  return { theme: terminalTheme(light), minimumContrastRatio: MINIMUM_CONTRAST[light ? "light" : "dark"] };
}

export function monoFont(): string {
  const fromCss = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  return fromCss || "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace";
}

let canvas: CanvasRenderingContext2D | null | undefined;

/** A computed CSS colour as `#rrggbb`, what an OSC reply carries; an oklch value resolves through a 1px canvas. */
export function hexOf(color: string, fallback: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  const hex = (channels: ArrayLike<number>) =>
    `#${Array.from(channels, (n) => Math.round(Number(n)).toString(16).padStart(2, "0")).join("")}`;
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color);
  if (rgb) return hex(rgb.slice(1, 4).map(Number));
  if (canvas === undefined) {
    try {
      const el = document.createElement("canvas");
      el.width = el.height = 1;
      canvas = el.getContext("2d", { willReadFrequently: true });
    } catch {
      canvas = null;
    }
  }
  if (!canvas || !color) return fallback;
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillStyle = color;
  canvas.fillRect(0, 0, 1, 1);
  return hex(canvas.getImageData(0, 0, 1, 1).data.slice(0, 3));
}

/** OSC 10/11/12 replies, so CLIs (vim, tmux, …) see the colours on screen: the theme's text and cursor, the content background. */
export function oscColors(light = isLightScheme()) {
  const theme = terminalTheme(light);
  const fallback = light ? TERMINAL_FALLBACK.light : TERMINAL_FALLBACK.dark;
  return {
    fg: hexOf(theme.foreground, fallback.foreground),
    bg: hexOf(cssColor("var(--color-background)", fallback.background), fallback.background),
    cursor: hexOf(theme.cursor, fallback.accent),
  };
}

/** A terminal tab. The page at /ui has no shell to spawn (a tab restored
 *  from an old web layout lands here), so it says so instead. */
export function TerminalView(props: Props) {
  if (isWebMode())
    return (
      <Empty>
        <EmptyTitle>{DESKTOP_ONLY_LINE}</EmptyTitle>
      </Empty>
    );
  return <ShellTerminal {...props} />;
}

/** The status poll runs only for the shown terminal of a shown pane while the document is visible. */
export function statusPollAllowed(active: boolean, paneVisible: boolean, documentHidden: boolean): boolean {
  return active && frameLoopAllowed(paneVisible, documentHidden);
}

function ShellTerminal({ id, cwd, active, onMetaChange }: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const spawned = useRef(false);
  const applySizeRef = useRef<() => void>(() => {});
  const onMetaChangeRef = useRef(onMetaChange);
  onMetaChangeRef.current = onMetaChange;
  const runningProcessRef = useRef<string | null>(null);

  useEffect(() => {
    const outer = outerRef.current;
    const host = hostRef.current;
    if (!outer || !host) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: monoFont(),
      fontSize: 13,
      lineHeight: 1,
      letterSpacing: 0,
      scrollback: 5000,
      allowTransparency: true,
      smoothScrollDuration: 0,
      ...terminalScheme(),
      macOptionIsMeta: IS_MAC,
    });
    term.open(host);
    termRef.current = term;
    let closed = false;

    const onCopy = (event: ClipboardEvent) => {
      const text = term.getSelection();
      if (!text) return;
      event.clipboardData?.setData("text/plain", text);
      event.preventDefault();
    };
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      term.paste(text);
    };
    host.addEventListener("copy", onCopy);
    host.addEventListener("paste", onPaste);

    term.attachCustomKeyEventHandler((event) => {
      const mod = modOrCtrl(event);
      if (!mod || event.altKey) return true;
      const key = event.key.toLowerCase();
      if (key === "c") {
        if (term.hasSelection()) return false;
        if (macCommand(event)) return false;
        return true;
      }
      if (key === "v") return false;
      return true;
    });

    let oscBuffer = "";

    const unsubscribe = subscribePty(
      id,
      (data) => {
        const onMeta = onMetaChangeRef.current;
        if (onMeta) {
          const text = new TextDecoder().decode(data);
          const scanned = scanOscCwd(text, oscBuffer);
          oscBuffer = scanned.rest;
          if (scanned.cwd) {
            const patch: TerminalMetaPatch = { cwd: scanned.cwd };
            if (!runningProcessRef.current) {
              patch.title = defaultTerminalTitle(scanned.cwd);
            }
            onMeta(patch);
          }
        }
        return new Promise<void>((resolve) => term.write(data, resolve));
      },
      (code) => {
        if (closed) return;
        const status = code == null ? "" : ` (${code})`;
        term.writeln(`\r\n[process exited${status}]`);
      },
    );

    const dataSub = term.onData((data) => {
      void writePty(id, data);
    });

    const replyOsc = (code: 10 | 11 | 12, hex: string) => {
      const reply = oscColorReply(code, hex);
      if (reply) void writePty(id, reply);
      return true;
    };
    const oscFg = term.parser.registerOscHandler(10, (data) =>
      isOscColorQuery(data) ? replyOsc(10, oscColors().fg) : false,
    );
    const oscBg = term.parser.registerOscHandler(11, (data) =>
      isOscColorQuery(data) ? replyOsc(11, oscColors().bg) : false,
    );
    const oscCursor = term.parser.registerOscHandler(12, (data) =>
      isOscColorQuery(data) ? replyOsc(12, oscColors().cursor) : false,
    );

    const onSchemeChange = () => {
      Object.assign(term.options, terminalScheme());
    };
    window.addEventListener(SCHEME_CHANGE_EVENT, onSchemeChange);

    term.attachCustomWheelEventHandler(() => {
      if (term.element?.classList.contains("enable-mouse-events")) return true;
      return term.buffer.active.type !== "alternate";
    });

    let lastCols = 0;
    let lastRows = 0;
    let raf = 0;
    let tuiMode = false;

    const fitMode = (): TerminalFitMode =>
      term.buffer.active.type === "alternate" ? "tui" : "shell";

    const syncAltScreenMode = () => {
      const next = fitMode() === "tui";
      if (next === tuiMode) return;
      tuiMode = next;
      applyTerminalChrome(term, outer, next);
      if (!next) resetGridStretch(term);
      lastCols = 0;
      lastRows = 0;
      schedule();
    };

    const applySize = () => {
      if (closed) return;
      const next = fitTerminal(term, host, fitMode());
      if (!next) return;
      const { cols, rows } = next;
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      if (!spawned.current) {
        spawned.current = true;
        void spawnPty(id, cwd, cols, rows)
          .then((missing) => {
            if (!missing) return;
            term.writeln(
              `\x1b[2m${missing} is missing; this shell opened in your home folder.\x1b[0m`,
            );
          })
          .catch((error) => {
            spawned.current = false;
            lastCols = 0;
            lastRows = 0;
            const message =
              error instanceof Error ? error.message : String(error);
            term.writeln(`\x1b[31m${message}\x1b[0m`);
          });
        return;
      }
      void resizePty(id, cols, rows);
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        applySize();
      });
    };

    applySizeRef.current = applySize;
    const renderSub = term.onRender(() => {
      if (!spawned.current) applySize();
    });
    const bufferSub = term.buffer.onBufferChange(syncAltScreenMode);
    syncAltScreenMode();
    const frame = requestAnimationFrame(applySize);
    const observer = new ResizeObserver(schedule);
    observer.observe(host);

    return () => {
      closed = true;
      cancelAnimationFrame(frame);
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      outer.classList.remove("monocode-terminal--alt-screen");
      applySizeRef.current = () => {};
      host.removeEventListener("copy", onCopy);
      host.removeEventListener("paste", onPaste);
      window.removeEventListener(SCHEME_CHANGE_EVENT, onSchemeChange);
      dataSub.dispose();
      oscFg.dispose();
      oscBg.dispose();
      oscCursor.dispose();
      renderSub.dispose();
      bufferSub.dispose();
      unsubscribe();
      void killPty(id);
      term.dispose();
      termRef.current = null;
      spawned.current = false;
    };
  }, [id, cwd]);

  // Identity-stable: the callers pass an inline arrow, so depending on the
  // prop itself would tear down and re-arm the poll — and re-fork `ps` — on
  // every parent render.
  const wantsMeta = !!onMetaChange;
  // The status poll forks `ps` on the host: only the shown terminal of a
  // shown pane polls; a parked warm one, or another tab's, polls nothing and
  // reads once when it comes back.
  const paneVisible = usePaneVisible();

  useEffect(() => {
    if (!wantsMeta) return;
    let lastForeground: string | null = null;
    let inFlight = false;
    const refresh = () => {
      if (!spawned.current) return;
      // Each status read forks `ps`; an off-screen window has no title to paint.
      if (!statusPollAllowed(active, paneVisible, document.hidden)) return;
      if (inFlight) return;
      inFlight = true;
      void getPtyStatus(id)
        .then(({ foreground }) => {
          const fg = foreground?.trim() || null;
          runningProcessRef.current = fg;
          if (fg === lastForeground) return;
          lastForeground = fg;
          onMetaChangeRef.current?.(
            fg
              ? { title: fg, foreground: fg }
              : { title: defaultTerminalTitle(cwd), foreground: null },
          );
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
    refresh();
    // A parked pane or another tab arms no interval at all (it reads once
    // on return); a hidden window keeps the listener, so showing it reads
    // again and the interval's reads resume.
    if (!active || !paneVisible) return;
    const interval = setInterval(refresh, 1000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [id, cwd, wantsMeta, active, paneVisible]);

  useEffect(() => {
    if (!active) return;
    applySizeRef.current();
    termRef.current?.focus();
  }, [active]);

  return (
    <div
      ref={outerRef}
      className="monocode-terminal flex h-full w-full min-h-0 min-w-0 flex-col"
      onMouseDown={() => termRef.current?.focus()}
    >
      <div
        ref={hostRef}
        className="monocode-terminal-host min-h-0 min-w-0 flex-1 overflow-hidden"
      />
    </div>
  );
}
