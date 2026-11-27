// bun run ui:preview src/renderer/src/surfaces/settings/computers/Winvm.tsx#WinvmView --shot --fresh
// The Windows VM's rows while its display and restore points are read (each select and the points' line drawn from a
// sample, as bones) beside the same rows loaded, so each bone can be seen to stand where its words land.
import type { WinvmPoint, WinvmState } from "@shared/contract-work-winvm";
import type { WinvmViewProps } from "./Winvm";

const awake: WinvmState = {
  state: "awake",
  step: null,
  error: null,
  cannot: null,
  sleepAfter: "30m",
  since: 1,
  display: { device: "virtio", width: 1280, height: 800, scale: 100, fit: false, detail: "sharp", canResize: true },
} as WinvmState;
const points: WinvmPoint[] = [
  { id: "p1", name: "Before Office", at: Date.UTC(2026, 10, 24, 22, 12), by: "owner" },
  { id: "p2", name: "Nightly", at: Date.UTC(2026, 10, 25, 9, 0), by: "keeper" },
] as WinvmPoint[];
const still = () => {};
const base: Omit<WinvmViewProps, "points" | "settings"> = {
  state: awake,
  error: null,
  pressing: false,
  onPress: still,
  onSleepAfter: still,
  onScreen: still,
  onQuality: still,
  onPoints: still,
};

export const WinvmViewFixtures: { name: string; props: WinvmViewProps }[] = [
  { name: "its display and points read: selects and the count drawn as bones", props: { ...base, points: null, settings: null } },
  { name: "the same rows, loaded", props: { ...base, points, settings: { screen: "1280x800", detail: "sharp" } } },
];
