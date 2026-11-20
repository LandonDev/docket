// A preview page for `bun run ui:preview src/renderer/src/work/winvm/WinvmSection.preview.tsx#WinvmStates`:
// the Windows VM's section of Settings → Work in each state. Rendered by nothing in the app.
import type { WinvmScreen, WinvmState } from "@shared/contract-work-winvm";
import { WinvmView } from "./WinvmSection";

const at = (s: Partial<WinvmState>): WinvmState => ({ state: "asleep", step: null, error: null, cannot: null, sleepAfter: "30m", since: 1, ...s });
const noop = (): void => undefined;
const DAY = Date.UTC(2026, 10, 20, 15, 4);
const states: { name: string; state: WinvmState; points: { id: string; name: string; at: number; by: "owner" | "keeper" }[] | null; error?: string; screen?: WinvmScreen }[] = [
  { name: "Not set up", state: at({ state: "none" }), points: [] },
  { name: "Setting up", state: at({ state: "setting-up", step: "Copying the service in" }), points: [] },
  { name: "Asleep, with points", state: at({ state: "asleep" }), points: [{ id: "p1", name: "Before setup", at: DAY, by: "keeper" }] },
  { name: "Awake, the larger screen picked", state: at({ state: "awake", sleepAfter: "2h" }), points: [], screen: "1920x1200" },
  { name: "A wake that failed", state: at({ state: "asleep", error: "Windows did not answer in time; try again" }), points: [] },
];

export function WinvmStates() {
  return (
    <div className="flex w-[640px] flex-col gap-8 p-6">
      {states.map((s) => (
        <figure key={s.name} className="m-0 flex flex-col gap-2">
          <figcaption className="text-xs text-muted-foreground">{s.name}</figcaption>
          <WinvmView title="Windows VM" state={s.state} points={s.points} screen={s.screen ?? "1280x800"} error={s.error ?? null} pressing={false} onPress={noop} onSleepAfter={noop} onScreen={noop} onPoints={noop} />
        </figure>
      ))}
    </div>
  );
}
