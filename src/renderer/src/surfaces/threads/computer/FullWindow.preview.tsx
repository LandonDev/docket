// A preview page for `bun run ui:preview
// src/renderer/src/surfaces/threads/computer/FullWindow.preview.tsx#FullWindowStates`:
// every fixture of full screen at its display's size, on matte; and
// `#FullScreenProof`: the Windows VM's 1280 by 800 screen on the stage and in
// full screen on the MacBook's display and the ASUS's, with each picture's box.
// Rendered by nothing in the app.
import { ComputersPage } from "../../ComputersView";
import { shot } from "../../ComputersView.fixtures";
import { fitStage, stageLayout } from "../../../lib/stageLayout";
import { FullWindowView } from "./FullWindow";
import { FullScreenHint } from "./FullScreenHint";
import fixtures, { streamOf, tile, vmPicture, vmTile } from "./FullWindow.fixtures";

export function FullWindowStates({ only }: { only?: number[] }) {
  const shown = only ? only.map((i) => fixtures[i]).filter(Boolean) : fixtures;
  return (
    <div className="flex flex-col gap-8 p-4">
      {shown.map((fixture) => (
        <figure key={fixture.name} className="m-0 flex flex-col gap-2">
          <figcaption className="text-xs text-muted-foreground">{fixture.name}</figcaption>
          <div className="bg-matte" style={{ width: fixture.props.room.width, height: fixture.props.room.height }}>
            <FullWindowView {...fixture.props} />
          </div>
        </figure>
      ))}
    </div>
  );
}

/** The two displays the plan's numbers are for, in points at 2x. */
const DISPLAYS = [
  { name: "MacBook", width: 1728, height: 1117 },
  { name: "ASUS", width: 3200, height: 1800 },
] as const;
/** The Computers page's 40px header, with the rail closed: the page's body is the display less it. */
const HEADER = 40;
const VM = { status: "live", app: "Windows VM", window: null, width: 1280, height: 800, drawn: true } as const;
const noop = (): void => {};

export function FullScreenProof({ display }: { display?: "MacBook" | "ASUS" }) {
  const shown = display ? DISPLAYS.filter((d) => d.name === display) : DISPLAYS;
  return (
    <div className="flex flex-col gap-8 p-4">
      {shown.map((d) => {
        const body = { width: d.width, height: d.height - HEADER };
        const stage = fitStage(stageLayout(body, 1).room, VM, 2, "screen");
        const full = fitStage(d, VM, 2, "screen");
        const win = fitStage(d, VM, 2, "window");
        return (
          <section key={d.name} className="flex flex-col gap-4">
            <figure data-proof={`stage ${d.name}`} className="m-0 flex flex-col gap-2">
              <figcaption className="text-xs text-muted-foreground">{`${d.name}, the stage: the page's body ${body.width} by ${body.height}, the VM's picture ${stage.width} by ${stage.height}`}</figcaption>
              <div className="flex flex-col bg-background" style={body}>
                <ComputersPage tiles={[{ ...vmTile, driving: false }]} onOpenSession={noop} size={body} pictureOf={(_t, place) => shot("vm", "Live view of Windows VM", "screen")(place)} />
              </div>
            </figure>
            <figure data-proof={`full ${d.name}`} className="m-0 flex flex-col gap-2">
              <figcaption className="text-xs text-muted-foreground">{`${d.name}, full screen: ${d.width} by ${d.height}, the VM's picture ${full.width} by ${full.height}`}</figcaption>
              <div className="bg-matte" style={{ width: d.width, height: d.height }}>
                <FullWindowView tile={vmTile} stream={streamOf(VM)} room={d} name="Live view of Windows VM" dpr={2} onExit={noop} onOpenSession={noop} picture={vmPicture} />
              </div>
            </figure>
            <figure data-proof={`window ${d.name}`} className="m-0 flex flex-col gap-2">
              <figcaption className="text-xs text-muted-foreground">{`${d.name}, full screen, a 1280 by 800 window's picture: ${win.width} by ${win.height}, two screen pixels to each`}</figcaption>
              <div className="bg-matte" style={{ width: d.width, height: d.height }}>
                <FullWindowView tile={tile()} stream={streamOf(VM)} room={d} name="Live view" dpr={2} onExit={noop} onOpenSession={noop} picture={vmPicture} />
              </div>
            </figure>
          </section>
        );
      })}
    </div>
  );
}

/** `#FullScreenHintStates`: the two ways out over the Windows VM's picture, as a Mac and a PC say them. */
export function FullScreenHintStates() {
  return (
    <div className="flex flex-col gap-8 p-4">
      {[true, false].map((mac) => (
        <div key={String(mac)} className="relative bg-matte" style={{ width: 832, height: 520 }}>
          <div className="absolute inset-0">{vmPicture}</div>
          <FullScreenHint driving mac={mac} />
        </div>
      ))}
    </div>
  );
}
