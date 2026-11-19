import { getCurrentWindow, isWebMode, nativePlatform } from "../lib/native";
import { SCHEME_CHANGE_EVENT } from "../lib/appearance";
import { Copy, Minus, Square, X } from "./icons";
import { useEffect, useState } from "react";
import { Tip } from "../components/tip";
import { Button } from "../components/ui/button";
import { TooltipProvider } from "../components/ui/tooltip";

/**
 * Windows draws its own minimise, maximise and close over the bar's end
 * (src/main/windowFrame.ts): this is the room they take, nothing more. The
 * width is the system's own measure of them, so it holds at any zoom and
 * display scale; three 46px buttons until the window says. The glyphs take
 * the ink of the app's theme, which only the page knows, so the page says
 * what it sits on in its theme-color and main reads that.
 */
const CAPTION_SPACE = "calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px)))";

// First paint on every platform: plain functions, out of the compiler's memo output.
function CaptionSpace() {
  "use no memo";
  useEffect(followTheme, []);
  return <div data-caption-space className="h-full shrink-0" style={{ width: CAPTION_SPACE }} />;
}

/** The shell's colour in a theme-color tag, now and on every theme change. */
function followTheme() {
  const meta = document.head.appendChild(document.createElement("meta"));
  meta.name = "theme-color";
  const tell = () => (meta.content = getComputedStyle(document.documentElement).getPropertyValue("--sidebar").trim());
  tell();
  window.addEventListener(SCHEME_CHANGE_EVENT, tell);
  return () => (window.removeEventListener(SCHEME_CHANGE_EVENT, tell), meta.remove());
}

/** The window's controls at a title bar's end off macOS: Windows' own on a Windows desktop, ours on Linux and at /ui. */
export function WindowControls() {
  "use no memo";
  return !isWebMode() && nativePlatform() === "win32" ? <CaptionSpace /> : <DrawnControls />;
}

function DrawnControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;

    const win = getCurrentWindow();
    void win.isMaximized().then((max) => {
      if (mounted) setIsMaximized(max);
    }).catch(() => {});

    void win.onResized(async () => {
      try {
        const max = await win.isMaximized();
        if (mounted) setIsMaximized(max);
      } catch {}
    }).then((unlistenFn) => {
      if (mounted) {
        unlisten = unlistenFn;
      } else {
        unlistenFn();
      }
    }).catch(() => {});

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  const handleMinimize = () => {
    try {
      void getCurrentWindow().minimize();
    } catch {}
  };

  const handleToggleMaximize = () => {
    try {
      void getCurrentWindow().toggleMaximize();
    } catch {}
  };

  const handleClose = () => {
    try {
      void getCurrentWindow().close();
    } catch {}
  };

  return (
    <TooltipProvider>
      <div className="flex h-full shrink-0 items-stretch border-l border-border" data-tauri-drag-region="false">
        <Tip label="Minimize" side="bottom">
          <Button
            variant="ghost"
            aria-label="Minimize window"
            data-tauri-drag-region="false"
            onClick={handleMinimize}
            className="h-full w-10 rounded-none text-muted-foreground"
          >
            <Minus className="size-3.5" />
          </Button>
        </Tip>
        <Tip label={isMaximized ? "Restore" : "Maximize"} side="bottom">
          <Button
            variant="ghost"
            aria-label={isMaximized ? "Restore window" : "Maximize window"}
            data-tauri-drag-region="false"
            onClick={handleToggleMaximize}
            className="h-full w-10 rounded-none text-muted-foreground"
          >
            {isMaximized ? <Copy className="size-3" /> : <Square className="size-3" />}
          </Button>
        </Tip>
        <Tip label="Close" side="bottom">
          <Button
            variant="ghost"
            aria-label="Close window"
            data-tauri-drag-region="false"
            onClick={handleClose}
            className="h-full w-10 rounded-none text-muted-foreground hover:bg-destructive hover:text-destructive-foreground active:bg-destructive/90"
          >
            <X className="size-3.5" />
          </Button>
        </Tip>
      </div>
    </TooltipProvider>
  );
}
