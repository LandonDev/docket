import type { ServiceView, UsageReport, UsageWindow } from "aliax-core/shared/types";

/*
 * The Accounts page's samples (docs/agents/loading-bones.md "Samples"): what
 * its bones are drawn from while a read is out. Nobody reads the words; their
 * lengths and which fields are set give the bones the page's shape. A fixed
 * clock, so a reset line is always a reset line's length.
 */

/** The samples' clock: every reset below is counted from it. */
export const SAMPLE_NOW = Date.UTC(2026, 10, 12, 15);
const HOUR = 3_600_000;

/** A row's usage windows in the order the page draws them; a row's bones take as many as its columns hold. */
const SAMPLE_WINDOWS: readonly UsageWindow[] = [
  { label: "5h", usedPercent: 38, resetsAt: SAMPLE_NOW + 2 * HOUR, periodMs: 5 * HOUR },
  { label: "week", usedPercent: 54, resetsAt: SAMPLE_NOW + 72 * HOUR, periodMs: 168 * HOUR },
  { label: "opus", usedPercent: 20, resetsAt: SAMPLE_NOW + 72 * HOUR, periodMs: 168 * HOUR },
  { label: "sonnet", usedPercent: 12, resetsAt: SAMPLE_NOW + 72 * HOUR, periodMs: 168 * HOUR },
];

/** A signed-in row's report with `windows` windows (at most four, the page's cap). */
export const sampleReport = (windows: number): UsageReport => ({ profileName: "sample:row", windows: SAMPLE_WINDOWS.slice(0, windows) });

/** A key's report: one line of words over the window columns. */
export const SAMPLE_KEY_REPORT: UsageReport = { profileName: "sample:key", windows: [], note: "pay as you go" };

const row = (name: string, nickname: string, active: boolean) => ({ name: `sample:${name}`, email: name, nickname, createdAt: 1, active });

/** Three sections of two rows, as many as a first screen of the page holds. */
export const SAMPLE_ACCOUNT_VIEWS: ServiceView[] = [
  { id: "claude-code", name: "Claude Code", installed: true, canAddAccount: true, canSaveCurrent: false, switchTargets: [], profiles: [row("main@example.com", "Personal", true), row("team@example.com", "Work account", false)] },
  { id: "codex", name: "Codex", installed: true, canAddAccount: true, canSaveCurrent: false, switchTargets: [], profiles: [row("work@example.com", "Work", true), row("spare@example.com", "Spare account", false)] },
  { id: "muse-code", name: "Muse Code", installed: true, canAddAccount: true, canSaveCurrent: false, switchTargets: [], profiles: [row("muse@example.com", "Personal", true), row("lab@example.com", "Lab account", false)] },
];

const plan = { name: "Max 20x", monthlyUsd: 200, renewsAt: SAMPLE_NOW + 12 * 24 * HOUR };

/** Each sample row's report: two windows and its plan's line under the name. */
export const SAMPLE_ACCOUNT_USAGE: Partial<Record<ServiceView["id"], UsageReport[]>> = Object.fromEntries(
  SAMPLE_ACCOUNT_VIEWS.map((s) => [s.id, s.profiles.map((p) => ({ ...sampleReport(2), profileName: p.name, plan }))]),
);
