// A preview page for `bun run ui:preview
// src/renderer/src/surfaces/ComputersView.preview.tsx#ComputersStates`:
// every fixture of the Computers page's body at its width, on the page's own
// fill. Rendered by nothing in the app.
import { ComputersPage, RestingVmPicture } from "./ComputersView";
import { restingVmTiles, type VmState } from "../lib/winvmWake";
import fixtures from "./ComputersView.fixtures";

export function ComputersStates({ only }: { only?: number[] }) {
  const shown = only ? only.map((i) => fixtures[i]).filter(Boolean) : fixtures;
  return (
    <div className="flex flex-col gap-8 p-4">
      {shown.map((fixture) => (
        <figure key={fixture.name} className="m-0 flex flex-col gap-2">
          <figcaption className="text-xs text-muted-foreground">{fixture.name}</figcaption>
          <div className="flex flex-col border border-border bg-background" style={{ width: fixture.width, height: fixture.height }}>
            <ComputersPage {...fixture.props} size={{ width: fixture.width, height: fixture.height }} />
          </div>
        </figure>
      ))}
    </div>
  );
}

// `#ComputersVm`: the Windows VM's tile on the stage while it is not awake, in each state, at the page's width.
export function ComputersVm() {
  const never = (): Promise<void> => new Promise(() => undefined);
  const states: { name: string; vm: VmState; stage: true }[] = [
    { name: "Asleep, on the stage: it wakes by itself", vm: { state: "asleep", cannot: null, error: null }, stage: true },
    { name: "Not set up", vm: { state: "none", cannot: null, error: null }, stage: true },
  ];
  return (
    <div className="flex flex-col gap-8 p-4">
      {states.map((state) => {
        const tiles = restingVmTiles({ box: state.vm }, [], () => "The box");
        return (
          <figure key={state.name} className="m-0 flex flex-col gap-2">
            <figcaption className="text-xs text-muted-foreground">{state.name}</figcaption>
            <div className="flex flex-col border border-border bg-background" style={{ width: 960, height: 640 }}>
              <ComputersPage
                tiles={tiles}
                onOpenSession={() => undefined}
                size={{ width: 960, height: 640 }}
                pictureOf={(tile, place) => <RestingVmPicture host="box" vm={tile.vm!} place={place} wake={never} />}
              />
            </div>
          </figure>
        );
      })}
    </div>
  );
}
