import "./previewMac";
import { useEffect, useState, type ReactNode } from "react";
import { setWorkOn } from "../../lib/workSwitch";
import { CATALOG } from "@server/shared/catalog";
import { DEFAULT_PLAN_SETTINGS } from "@server/shared/plans";
import { DEFAULT_REVIEW_SETTINGS } from "@server/shared/review";
import { emptyAccounts } from "@server/shared/accounts";
import { DEFAULT_RULES, withProbedDefaults } from "@server/shared/rules";
import { Page, PageEmpty } from "../../components/page";
import { WEB_ENVIRONMENT_ID, registry, type Link } from "../../lib/connection";
import { noteSeen } from "../../lib/connection/lastSeen";
import { IDLE_STATUS, type EnvironmentStatus } from "../../lib/connection/types";
import { NO_ANSWER } from "../../lib/connection/openRead";
import { FailuresSaidOnce } from "./parts/ReadFailure";
import { bindServer } from "../../lib/native";
import { settingsSectionDescription } from "../../lib/settings";
import { dropHarnessAvailability } from "../../lib/harness/availability";
import { registerBuiltinHarnesses } from "../../lib/harness/register";
import { resetCatalogProbes } from "../../lib/tcserver/catalog";
import { resetPlanSettingsForTests } from "../../lib/tcserver/plans";
import { rulesStore, type RulesCatalog } from "../../lib/tcserver/rules";
import { useWorkspaces, workspaceStore } from "../../lib/tcserver/workspaces";
import { ReviewsPage } from "../ReviewSettings";
import { EditorPage } from "./Editor";
import { GeneralPage } from "./General";
import { UpdatesPage } from "./Updates";
import { updateStore } from "../../lib/updateStore";
import { AppshotsPage } from "../AppshotsSettings";
import { loadAppshotSettings, resetAppshotSettingsForTests } from "../../lib/appshots";
import { setEditorConfigForTest } from "../../lib/editorConfig";
import { ThreadsPage } from "./computers/ThreadsPage";
import { SyncLine, SyncPage } from "./computers/SyncPage";
import { PublishPage } from "./computers/PublishPage";
import { WinvmPage } from "./computers/Winvm";
import { tellSettingsList } from "../../lib/settings/useListWindow";
import { ComputerLine, OtherComputerPage } from "./computers/ComputerPage";
import { deployDriftStore } from "../../lib/deployDrift";
import { SharingPage } from "./computers/SharingPage";
import { MayBody } from "./computers/MaySheet";
import { macBridgeStore } from "../../lib/macBridge";
import { hostDevicesStore } from "../../lib/hostDevices";
import { resetHostJobs } from "../../lib/hostJobs";
import type { MacBridgeHostPolicy } from "@shared/contract-macbridge";
import { KeybindingsPage } from "./Keybindings";
import { OrchestrationPage } from "./Orchestration";
import { ThreadDefaultsPage } from "./ThreadDefaults";
import { WorkspacePage } from "./Workspace";
import { ArchivePage } from "./Archive";
import { ProjectSettingsDialog } from "../../chrome/ProjectDialogs";
import type { ProjectMeta } from "../../lib/tcserver/types";
import { AppearancePage } from "./Appearance";
import { AddonsPage } from "./addons/AddonsPage";
import { SkillsPage } from "./skills/SkillsPage";
import { ComputerPage } from "./Computer";
import { AwayPage } from "./Away";
import { AccountsFoot } from "./AccountsFoot";
import { awayStore } from "../../lib/away";
import { HomeLine } from "./parts/HomeLine";
import { resetPageHomesForTests } from "../../lib/settings/pageHome";
import { CodeWorkspaceSector, JobPage } from "../../work/shell/JobSettings";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { WorkPage, workOffAsk, workPageChunk } from "./Work";
import { resetOwnComputerForTests } from "../../lib/settings/computerName";
import { resetOutboxStore } from "../../work/outbox/store";
import { StoreGrantsSheet, ToolsSheet } from "../../work/shell/WorkPageSends";
import { FilesPage } from "../../work/shell/WorkPageFiles";
import { ConnectionsView } from "../../work/connections/ConnectionsPage";
import type { HostView } from "../../work/connections/model";
import type { HealthRow } from "@shared/work/health";
import { GrantsRow } from "../../work/shell/WorkPageSends";
import { MailSettingsBody, Section as MailSection } from "../../work/mail/MailSettingsSection";
import { setLifeosStatus } from "../../work/shell/lifeos";
import { MailClientProvider } from "work-kit/mail";
import { corpusSignatures, corpusThreads, createFixtureMailClient } from "work-kit/mail/fixtures";
import { SettingSection } from "./parts/SettingRow";
import { SettingsSection as DigestPage } from "../../work/digest/SettingsSection";
import { resetDigestStore } from "../../work/digest/store";
import type { TeamsLibrary } from "@shared/contract-work-office";
import type { GuestLinkRow } from "@shared/contract-work-guests";
import { ConfirmDialog } from "../../chrome/ConfirmDialog";
import type { ToolRulesCard } from "@shared/contract-work-outbox";
import type { SettingPage } from "../../lib/settings/map";
import { computerSessionsStore } from "../../lib/computerSessions";
import type { ComputerServiceState, ComputerSettings } from "@shared/contract-computer";
import type { AddonGrantView } from "@shared/contract-addonGrants";
import type { AddonRow, AddonStatus } from "@shared/contract-addons";
import type { SkillMeta } from "@shared/contract-skills";

/**
 * Every Settings page over one fixed host, for `bun run ui:preview
 * src/renderer/src/surfaces/settings/SettingsPages.preview.tsx#SettingsPagePreview`
 * (the fixtures beside it): the page as its host answers it (`answers`),
 * while the host has not answered (`silent`: the skeletons in their shape),
 * and once it refused (`refuses`: each section's error and Retry). The
 * registry and the stores are pointed at one fake link that answers at once,
 * so the preview's one flush after the mount shows the page loaded. Rendered
 * by nothing in the app.
 */

export type HostMode = "answers" | "silent" | "refuses";

const WORKSPACE = { id: "w1", name: "temp-code", path: "/srv/agents/work/temp-code", git: true, githubRepo: "LandonDev/temp-code", createdAt: 1 };

const ANSWERS: Record<string, unknown> = {
  "doctor.get": {
    claude: { found: true, version: "2.1.263 (Claude Code)" },
    codex: { found: true, version: "codex-cli 0.162.1", error: "Login expired" },
    cursor: { found: false },
    java: { found: true, version: "21.0.4", jdtls: true, path: "/usr/lib/jvm/java-21", ideaServer: { dist: true, accepted: true, build: "263.2689" } },
  },
  "lsp.status": [
    { serverId: "s1", lang: "java", projectId: "p1", state: "running", memoryBytes: 612 * 1024 ** 2, idleMs: 240_000 },
    { serverId: "s2", lang: "web", projectId: "p1", state: "error", error: "Exited 1", idleMs: 0 },
  ],
  "linear.status": { connected: true },
  "linear.teams": [
    { id: "t1", name: "Core", key: "COR" },
    { id: "t2", name: "Web", key: "WEB" },
  ],
  "rules.get": { rules: withProbedDefaults(DEFAULT_RULES), overridden: true },
  "catalog.get": Object.fromEntries(Object.values(CATALOG).map((p) => [p.id, p])) as RulesCatalog,
  "defaults.get": { defaults: { provider: "claude", model: "", reasoning: "high", permission: "edits" }, overridden: false },
  "plans.get": { settings: DEFAULT_PLAN_SETTINGS, overridden: false },
  "review.get": { override: null, global: DEFAULT_REVIEW_SETTINGS, settings: DEFAULT_REVIEW_SETTINGS, source: "global" },
  "turnpass.get": { verify: true, build: false, commit: "off" },
  "build.get": { command: "bun run build", outputs: "out/**" },
  "build.detect": { command: "bun run build", outputs: "out/**" },
  "workspace.list": [WORKSPACE],
  "project.list": [],
  "remote.status": {
    environmentId: "env_1gP-MhkVVRaMwHbVCysYow",
    name: "MacBook Pro",
    enabled: true,
    port: 7677,
    configuredPort: 7677,
    running: true,
    error: null,
    // The base sign-in links start with: no address typed, so the one the tunnel taught.
    origin: "https://tempcode.landonhale.com",
    publicOrigin: "",
    learnedOrigin: "https://tempcode.landonhale.com",
    contract: 1,
    stuckMinutes: 30,
  },
  "remote.keys.list": [
    { id: "k1", name: "iPhone", audience: "client", caps: ["read", "operate", "approve"], kind: "bearer", createdAt: 1, lastUsedAt: null, revokedAt: null, createdBy: "local", webhookUrl: null, events: null },
  ],
  "remote.pairings.list": [],
  "remote.sessions.list": [],
  "remote.environments.list": [],
  "attachment.settings": { maxBytes: 64 * 1024 * 1024 },
  "power.status": { mode: "while-working", supported: true, holding: true, onBattery: false },
  "power.settings.set": { mode: "never", supported: true, holding: false, onBattery: false },
  "code.settings.get": { host: "env_box", hosts: [{ id: "env_box", name: "The box" }], cannot: null },
  // A computer with no AI account to pick: the workspace page and the project sheet say Auto.
  "accounts.list": emptyAccounts(),
  "appshots.get": { enabled: true, destination: "automatic", sound: true },
};

// Settings → Add-ons and Skills: four add-ons (Connected, Failed, Needs a key, Off; one a thread wrote) and three skills.
const addon = (over: Partial<AddonRow> & { name: string }): AddonRow => ({
  id: `ad_${over.name}`,
  workspaceId: null,
  description: "",
  spec: { transport: "stdio", command: "npx", args: [], env: [], auth: "none" },
  enabled: true,
  addedBy: { kind: "person" },
  writtenBy: { kind: "person" },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const ADDONS: AddonRow[] = [
  addon({
    name: "github",
    spec: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: ["GITHUB_TOKEN"], auth: "fields" },
    writtenBy: { kind: "thread", sessionId: "s1", environmentId: "local", title: "Fix the build" },
  }),
  addon({ name: "linear", spec: { transport: "http", url: "https://mcp.linear.app/mcp", headers: [], auth: "oauth" } }),
  addon({ name: "slack", workspaceId: "w1", spec: { transport: "http", url: "https://slack.example.com/mcp", headers: ["X-Api-Key"], auth: "fields", platforms: ["darwin"] } }),
  addon({ name: "playwright", enabled: false, spec: { transport: "stdio", command: "npx", args: ["@playwright/mcp"], env: [], auth: "none" } }),
];
const at = (state: AddonStatus["state"], over: Partial<AddonStatus> = {}): AddonStatus => ({ state, tools: 0, at: 1, ...over });
const ADDON_STATUS: Record<string, AddonStatus> = {
  ad_github: at("ready", { tools: 24 }),
  ad_linear: at("failed", { detail: "Disconnected: the server closed the stream" }),
  ad_slack: at("needs-grant", { detail: "Needs values for X-Api-Key" }),
  ad_playwright: at("off"),
};
const GRANTS: AddonGrantView[] = [
  { addonId: "ad_github", fields: [{ name: "GITHUB_TOKEN", set: true }], oauth: null, signIn: null, gaps: [] },
  { addonId: "ad_linear", fields: [], oauth: { signedIn: true, expiresAt: null, refreshedBy: "The box", refused: false }, signIn: null, gaps: [] },
];
const skill = (over: Partial<SkillMeta> & { name: string; description: string }): SkillMeta => ({
  id: `sk_${over.name}`,
  workspaceId: null,
  harnesses: "all",
  enabled: true,
  version: 1,
  digest: "d",
  bytes: 4096,
  fileCount: 1,
  addedBy: { kind: "import", from: "~/.claude/skills" },
  writtenBy: { kind: "import", from: "~/.claude/skills" },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const SKILLS: SkillMeta[] = [
  skill({
    name: "impeccable",
    description: "Use when the user wants to design, redesign, shape, critique, audit, polish, simplify, harden, animate, or otherwise improve a frontend interface",
    version: 3,
    writtenBy: { kind: "thread", sessionId: "s2", environmentId: "local", title: "Polish the rail" },
  }),
  skill({ name: "release-notes", description: "Write the release notes from the commit subjects since the last tag", harnesses: ["claude", "codex"], workspaceId: "w1" }),
  skill({ name: "swift-review", description: "Review Swift for data races and retain cycles", harnesses: ["codex"], enabled: false, version: 2 }),
];
const STORE_ANSWERS = {
  "addons.list": { addons: ADDONS, status: ADDON_STATUS, home: { name: "The box", online: true } },
  "addons.grant.list": { grants: GRANTS },
  "skills.list": { skills: SKILLS, home: { name: "The box", online: true } },
  // A skill's files, for its Edit… dialog.
  "skills.get": (params: unknown) => {
    const meta = SKILLS.find((one) => one.id === (params as { id?: string } | undefined)?.id) ?? SKILLS[1];
    return { skill: { ...meta, files: [{ path: "SKILL.md", text: `---\nname: ${meta.name}\ndescription: ${meta.description}\n---\n\nRead the commit subjects since the last tag and group them by area.\n` }] } };
  },
};
Object.assign(ANSWERS, STORE_ANSWERS);

// Settings → Computer use: five learned apps (two may take the screen, one saved before names were kept), Screen Recording off.
const COMPUTER_SETTINGS: ComputerSettings = {
  sessionIdleMs: 120_000,
  activeApp: "brief",
  keepPictures: true,
  videoRemote: false,
  apps: [
    { bundleId: "com.apple.TextEdit", name: "TextEdit", classes: { click: "process", type: "process" }, updatedAt: 1 },
    { bundleId: "com.google.Chrome", name: "Google Chrome", classes: { click: "session", scroll: "session", type: "session" }, updatedAt: 1 },
    { bundleId: "com.apple.calculator", name: "Calculator", classes: { key: "session" }, updatedAt: 1 },
    { bundleId: "com.apple.finder", name: "Finder", classes: { click: "process" }, updatedAt: 1 },
    { bundleId: "com.example.Legacy", name: null, classes: {}, updatedAt: 1 },
  ],
};
Object.assign(ANSWERS, {
  "computer.settings.get": COMPUTER_SETTINGS,
  "computer.permissions": { accessibility: true, screenRecording: false },
});
const COMPUTER_UP: ComputerServiceState = { state: "up", pid: 4242, epoch: "e1", restarts: 0, permissions: { accessibility: true, screenRecording: false } };
const COMPUTER_DOWN: ComputerServiceState = {
  state: "down",
  reason: "tc-computer crashed 5 times in two minutes: fatal error",
  until: 1,
  restarts: 5,
  permissions: null,
};
const OFFLINE = { name: "The box", online: false };

// Settings › Threads and Sharing (this Mac), and each other computer's page: what each computer answers.
const admission = (running: number, cap: number, queued: number) => ({
  cap,
  pinned: null,
  default: cap,
  running,
  queued,
  memory: { budgetMB: 81920, reserveMB: 20480, perProcessMB: 331, freeMB: 9216, floorMB: 8192 },
});
const BRIDGE_HOST = {
  shared: ["/Users/landon/Documents/shared", "/Users/landon/IdeaProjects"],
  showRunning: true,
  registered: true,
  maxRunning: 4,
  maxThreads: 2,
  running: 1,
  held: 0,
  threads: 1,
  computerUnavailable: null,
  maxComputer: 2,
  computerLive: 0,
};
const BRIDGE = [
  { ...BRIDGE_HOST, environmentId: "env_box", name: "The box", policy: "read+run", computer: true },
  { ...BRIDGE_HOST, environmentId: "env_pc", name: "PURDUE-LT", policy: "off", computer: false, shared: [], running: 0, threads: 0 },
];
const DEVICES_REPORT = {
  environmentId: "local",
  at: 1,
  simulators: [{ udid: "AAA", name: "iPhone 17 Pro", runtime: "iOS 27.0", state: "booted", cpu: 12.4, holder: { sessionId: "s1", title: "Unread marks and the Dock badge", status: "running" } }],
  phones: [],
  xcode: { path: "/Applications/Xcode.app", name: "Xcode", version: "27.0", from: "newest" },
  load: { oneMinute: 3.2, cores: 12 },
  problems: [],
};
const MINUTE = 60_000;
/** This Mac's release folder: a Docket checkout on master, one release past the last published. */
const PUBLISH = {
  job: "publish",
  phase: "idle",
  target: null,
  startedAt: null,
  finishedAt: null,
  exit: null,
  stoppable: false,
  checkout: "~/IdeaProjects/temp-code",
  readable: true,
  branch: "master",
  dirty: false,
  version: "1.0.400",
  masterVersion: "1.0.400",
  publishedVersion: "1.0.399",
  commits: ["Settings 2, computers"],
  notes: "Settings has a page for each computer.",
  refusal: null,
};
/** A computer's hello through a key: what it may do there and the release it runs. The key is this Mac's own, "b2" in
 *  the box's list of who can sign in. */
const helloOf = (caps: string[], release: number, key = "b2") =>
  ({ environmentId: "env", caps, key: { id: key, name: "MacBook Pro" }, build: { version: `1.0.${release}`, release, platform: "linux" } }) as unknown as EnvironmentStatus["lastHello"];
/** This Mac, the box and a PC set up from it. */
const THREE_COMPUTERS = [
  { id: "local", name: "MacBook Pro", routes: [], credentialRef: "local" },
  { id: "env_box", name: "The box", routes: [{ url: "wss://docket.landonhale.com/ws", kind: "tunnel" }], credentialRef: "env_box" },
  { id: "env_pc", name: "PURDUE-LT", routes: [], credentialRef: "env_pc" },
] as unknown as ReturnType<typeof registry.environmentsSnapshot>;
Object.assign(ANSWERS, {
  "admission.get": admission(2, 8, 0),
  "host.devices.hosts": [{ environmentId: "local", name: "This Mac", local: true }],
  "host.devices.watch": DEVICES_REPORT,
  "macBridge.policy.get": BRIDGE,
  "macBridge.load.get": { load: 3.2, cores: 12, limit: 24, pinned: false, busy: false, resumeBelow: 20 },
  "macBridge.rules.list": [],
  "macBridge.pending": [],
  "ports.forwards": { hosts: [{ environmentId: "env_box", enabled: true, forwards: [] }] },
  "remote.keys.list": [
    { id: "k1", name: "Landon's iPhone", audience: "client", caps: ["read", "operate", "approve"], kind: "bearer", client: "phone", createdAt: 1, lastUsedAt: Date.now() - 26 * 60 * MINUTE, revokedAt: null, createdBy: "local", webhookUrl: null, events: null },
  ],
  "env_box:admission.get": admission(118, 120, 7),
  "env_box:remote.status": {
    environmentId: "env_box",
    name: "The box",
    enabled: true,
    port: 7677,
    configuredPort: 7677,
    running: true,
    error: null,
    origin: "https://docket.landonhale.com",
    publicOrigin: "https://docket.landonhale.com",
    learnedOrigin: null,
    contract: 1,
    stuckMinutes: 10,
  },
  "env_box:attachment.settings": { maxBytes: 200 * 1024 * 1024 },
  "env_box:doctor.get": { claude: { found: true, version: "2.4.1 (Claude Code)" }, codex: { found: true, version: "codex-cli 0.164.0" } },
  "env_box:remote.keys.list": [
    { id: "b1", name: "Landon's iPhone", audience: "client", caps: ["read", "operate", "approve"], kind: "bearer", client: "phone", createdAt: 1, lastUsedAt: Date.now() - 3 * MINUTE, revokedAt: null, createdBy: "pairing:p", webhookUrl: null, events: null },
    { id: "b2", name: "MacBook Pro", audience: "client", caps: ["read", "operate", "approve", "admin"], kind: "bearer", client: "desktop", createdAt: 1, lastUsedAt: Date.now() - 1000, revokedAt: null, createdBy: "pairing:q", webhookUrl: null, events: null },
    { id: "b3", name: "PURDUE-LT", audience: "client", caps: ["read", "operate"], kind: "bearer", client: "desktop", createdAt: 1, lastUsedAt: Date.now() - 60 * MINUTE, revokedAt: null, createdBy: "giver", webhookUrl: null, events: null },
    { id: "b4", name: "grok", audience: "mcp", caps: ["read", "operate"], kind: "bearer", createdAt: 1, lastUsedAt: null, revokedAt: null, createdBy: "local", webhookUrl: null, events: null },
  ],
  "env_box:remote.sessions.list": [
    { id: "s1", keyId: "kb", keyName: "PURDUE-LT", caps: ["read", "operate"], userAgent: "Mozilla/5.0 Chrome/131.0", createdAt: 1, lastSeenAt: Date.now() - 2 * 24 * 60 * MINUTE, expiresAt: Date.now() + 1e9 },
  ],
  "env_box:remote.pairings.list": [],
  "env_box:host.deployStatus": { phase: "idle", installed: true, installHint: "", version: "1.0.397" },
  "env_box:work.get": { enabled: true },
  "remote.environments.list": [
    { id: "env_box", name: "The box", routes: [{ url: "wss://docket.landonhale.com/ws", kind: "tunnel" }, { url: "ws://10.0.0.5:7677/ws", kind: "lan" }], addedAt: 1, caps: ["admin"], keyName: "MacBook Pro" },
    { id: "env_pc", name: "PURDUE-LT", routes: [{ url: "wss://docket.landonhale.com/relay/env_pc/ws", kind: "tunnel" }], addedAt: 1, caps: ["read", "operate"], keyName: "MacBook Pro" },
  ],
  "devices.computers": {
    giver: null,
    box: null,
    computers: [
      { envId: "env_pc", name: "PURDUE-LT", state: "active", holds: [{ service: "claude-code", account: "a" }, { service: "codex", account: "b" }], syncedAt: Date.now() - 60 * MINUTE, paused: false, waitingForContact: false, lastError: null },
    ],
  },
  "env_pc:admission.get": admission(2, 6, 0),
  "env_pc:work.get": { enabled: false },
  "harness.status": {
    enabled: true,
    skipped: 2,
    environments: [
      { id: "env_box", name: "The box", connected: true, running: false, files: 212, sets: null, syncedAt: Date.now() - 2 * MINUTE, lastAttemptAt: null, error: null },
      { id: "env_pc", name: "PURDUE-LT", connected: true, running: false, files: 212, sets: null, syncedAt: Date.now() - 60 * MINUTE, lastAttemptAt: null, error: null },
    ],
    pathMap: { roots: {}, prefixes: {} },
  },
  "memory.status": {
    enabled: true,
    skipped: 0,
    environments: [
      { id: "env_box", name: "The box", connected: true, running: false, files: 48, syncedAt: Date.now() - 2 * MINUTE, lastAttemptAt: null, error: null, conflicts: 0 },
      { id: "env_pc", name: "PURDUE-LT", connected: true, running: false, files: 48, syncedAt: Date.now() - 60 * MINUTE, lastAttemptAt: null, error: null, conflicts: 1 },
    ],
    conflicts: [{ path: "/Users/landon/.claude/projects/x/memory/notes.conflict.md", of: ".claude/projects/x/memory/notes.md", host: "PURDUE-LT", at: Date.now() - 60 * MINUTE }],
  },
  "host.publishStatus": PUBLISH,
  "env_box:work.winvm.state": { state: "asleep", step: null, error: null, cannot: null, sleepAfter: "30m", since: 1, display: { device: "virtio", width: 2560, height: 1600, scale: 200, fit: true, detail: "sharp", canResize: true } },
  "env_box:work.winvm.settings": { sleepAfter: "30m", screen: "fit", detail: "sharp" },
  "env_box:work.winvm.points": { points: [{ id: "p1", name: "Before the Office update", at: Date.now() - 9 * 24 * 60 * MINUTE }] },
  "env_pc:attachment.settings": { maxBytes: 200 * 1024 * 1024 },
  "env_pc:doctor.get": { claude: { found: true, version: "2.4.1 (Claude Code)" }, codex: { found: true, version: "codex-cli 0.164.0" }, muse: { found: true, version: "1.3.0" } },
});
// A job's page (`ws:<id>` of a Work workspace) on the box, seen from this Mac: this Mac's bridge refuses the box, so
// its row carries the amber line; a PC beside it; the Windows VM; one rule proposed.
const MAC_ID = "env_1gP-MhkVVRaMwHbVCysYow";
const JOB = { id: "j1", name: "Purdue Esports", path: "/home/agents/work/Purdue Esports", kind: "work", sector: "purdue", environmentId: "env_box", createdAt: 1 } as WorkspaceMeta;
const JOB_HOSTS = [
  { id: "local", name: "This Mac", routes: [], credentialRef: "local", platform: "darwin" },
  { id: "env_box", name: "The box", routes: [], credentialRef: "env_box", platform: "linux" },
  { id: "env_pc", name: "PURDUE-LT", routes: [], credentialRef: "env_pc", platform: "win32" },
];
const PROJECT = { id: "p1", workspaceId: "w1", name: "settings-2", mode: "worktree", branch: "tc/settings-2", cwd: "/srv/agents/work/temp-code/.claude/worktrees/settings-2", archived: false, createdAt: 1, environmentId: "local" } as ProjectMeta;
const rule = (i: number, text: string, on = true) => ({ id: `r${i}`, workspaceId: JOB.id, text, on, proposalId: null, createdAt: i, updatedAt: i });
const JOB_ANSWERS: Record<string, unknown> = {
  "remote.status": { ...(ANSWERS["remote.status"] as object), name: "MacBook Pro" },
  "work.workspace.get": { mayUseDesktop: [MAC_ID, "env_pc"], windowsVm: true, model: null, reasoning: null, voice: true },
  "work.desktops": [],
  "work.winvm.state": { state: "asleep", step: null, error: null, cannot: null, sleepAfter: "30m", since: 0 },
  "work.office.filesCopyGet": { on: true },
  "work.rules.list": {
    rules: [rule(0, "Sign Purdue mail as Assistant Director, Esports"), rule(1, "Call it the Spring LAN, never the spring tournament"), rule(2, "Copy Sam Ortiz on anything about scrims", false)],
    proposals: [
      {
        id: "p1",
        workspaceId: JOB.id,
        text: "Open with the student's first name",
        line: "You changed “Hello” to the first name again.",
        state: "later",
        ruleId: null,
        edits: [{ draftId: "d1", to: "Sam Ortiz", subject: "Scrims on Friday", sentAt: 1, ops: [] }],
        updatedAt: 1,
      },
    ],
  },
  "work.rules.voice": { on: true, count: 48, since: Date.UTC(2026, 9, 21), from: [] },
  "work.mail.waiting": { days: 4, routine: false },
  "work.lifeos.status": { lifeos: { state: "connected", ownerId: "owner", since: 0 }, keys: [] },
  "macBridge.policy.get": [
    { environmentId: "env_box", name: "The box", policy: "off", shared: [], showRunning: false, registered: true, maxRunning: 4, maxThreads: 4, running: 0, held: 0, threads: 0, computer: false, computerUnavailable: null, maxComputer: 1, computerLive: 0 },
  ],
  "defaults.get": { defaults: { provider: "claude", model: "", reasoning: "high", permission: "auto" }, overridden: true },
};

let mode: HostMode = "answers";
/** The page's own answers over the shared ones (an empty list, an offline home). */
let overrides: Record<string, unknown> = {};
const CATALOG_LISTS = new Set(["workspace.list", "project.list", "catalog.get"]);

/** Every link a page reads through, one per computer: answers at once, never, or with a refusal. A computer's own
 *  answers are keyed `<environment id>:<method>` (another computer's page asks that computer, never this one). */
const links = new Map<string, Link>();
function linkFor(environmentId: string): Link {
  const known = links.get(environmentId);
  if (known) return known;
  const made = {
    environmentId,
    profile: environmentId,
    connected: true,
    onOpen: () => () => {},
    onClose: () => () => {},
    onPush: () => () => {},
    request<T>(method: string, params?: unknown): Promise<T> {
      // The catalog's own lists always answer: the fixtures are about the pages' reads.
      if (!CATALOG_LISTS.has(method)) {
        if (mode === "silent") return new Promise<T>(() => {});
        if (mode === "refuses") return Promise.reject(new Error(NO_ANSWER));
      }
      if (silentComputers.has(environmentId)) return new Promise<T>(() => {});
      for (const key of [`${environmentId}:${method}`, method]) {
        if (!(key in overrides) && !(key in ANSWERS)) continue;
        // An answer may depend on what was asked (a workspace's set, a project's review).
        const answer = key in overrides ? overrides[key] : ANSWERS[key];
        return Promise.resolve((typeof answer === "function" ? (answer as (params: unknown) => unknown)(params) : answer) as T);
      }
      return Promise.reject(new Error(`no ${method}`));
    },
  } as unknown as Link;
  links.set(environmentId, made);
  return made;
}
const link = linkFor("local");

/** Each computer's link as a fixture sets it: open with an admin hello, unless the fixture says otherwise. */
let statuses: Record<string, Partial<EnvironmentStatus>> = {};
/** Computers that never answer in this fixture (offline). */
let silentComputers = new Set<string>();
const statusCache = new Map<string, EnvironmentStatus>();
const OPEN: EnvironmentStatus = { ...IDLE_STATUS, transport: "open" };
Object.assign(registry, {
  primary: () => link,
  linkOf: (id: string) => linkFor(id),
  link: (id: string) => linkFor(id),
  environment: (id: string) => THREE_COMPUTERS.find((computer) => computer.id === id),
  statusOf: (id: string): EnvironmentStatus => {
    // One object per computer per fixture: a store's snapshot must not change between two reads.
    const known = statusCache.get(id);
    if (known) return known;
    const made = { ...OPEN, ...statuses[id] } as EnvironmentStatus;
    statusCache.set(id, made);
    return made;
  },
});
// The live harnesses, as the app registers them at boot: the Model picker lists the CLIs the host found.
registerBuiltinHarnesses();
// Linear's reads go through lib/native's server router, which the app binds at boot.
bindServer({ linkOf: () => link });

/** A fresh host for each fixture: the stores forget what an earlier fixture loaded. */
function prepare(next: HostMode, answers: Record<string, unknown> = {}, service: ComputerServiceState = COMPUTER_UP): void {
  mode = next;
  overrides = answers;
  // The service state rides the host's `computer` push; a silent host has sent none.
  computerSessionsStore.setState({ serviceByHost: next === "silent" ? {} : { local: service } });
  resetPlanSettingsForTests();
  resetCatalogProbes();
  dropHarnessAvailability("local");
  rulesStore.reset();
  rulesStore.attach(link);
  // This Mac's rules for the box and PURDUE-LT, as its server last listed them.
  macBridgeStore.setState({ hosts: BRIDGE as MacBridgeHostPolicy[], load: { load: 3.2, cores: 12, limit: 24, pinned: false, busy: false, resumeBelow: 20 } as never, requests: {} });
  hostDevicesStore.setState({ hosts: null, reports: {}, errors: {} });
  resetHostJobs();
  workspaceStore.reset();
  workspaceStore.attach(link);
  // The editors this computer has, as main would answer: Auto opens IntelliJ IDEA.
  setEditorConfigForTest(next === "answers" ? { editor: "auto", effective: "idea", installed: { idea: true, code: true, xed: false } } : null);
  resetAppshotSettingsForTests();
  void loadAppshotSettings();
}

/**
 * A Mac's desktop window, for the pages only a desktop draws (Keep this Mac awake, the capture key, Appshots): the
 * bridge they read, as main would answer it, with Screen Recording still to grant. It stays once set, so these
 * fixtures are listed last.
 */
function AsMac({ children }: { children: ReactNode }) {
  useState(() => {
    const key = { key: "Alt+Shift+Space", defaultKey: "Alt+Shift+Space", held: true, error: null, workOn: true };
    const api = (window as unknown as { api?: Record<string, unknown> }).api;
    (window as unknown as { api: unknown }).api = {
      ...api,
      platform: "darwin",
      captureKey: { get: async () => key, set: async () => key },
      appshots: { permissions: async () => ({ available: true, screen: false, ax: true }), onCapture: () => () => {}, onError: () => () => {} },
      // Main's editors, as the fixture's computer answers: never while silent, a refusal once it refused.
      editor: {
        config: () =>
          mode === "silent" ? new Promise(() => {}) : mode === "refuses" ? Promise.reject(new Error(NO_ANSWER)) : Promise.resolve({ editor: "auto", effective: "idea", installed: { idea: true, code: true, xed: false } }),
      },
    };
  });
  return children;
}

/** A computer last seen some minutes ago, as the link notes it on every open. */
/** Work's last answer from a computer, as its page kept it when it was last in reach. */
function WorkSeen({ environmentId, on, children }: { environmentId: string; on: boolean; children: ReactNode }) {
  useState(() => localStorage.setItem("docket.settings.workSeen", JSON.stringify({ [environmentId]: on })));
  return children;
}

function SeenAgo({ environmentId, minutes, children }: { environmentId: string; minutes: number; children: ReactNode }) {
  useState(() => noteSeen(environmentId, Date.now() - minutes * MINUTE));
  return children;
}

/** The list told which computer holds the Windows VM, as SettingsView's hook tells it. */
function WithVmOn({ environmentId, children }: { environmentId: string; children: ReactNode }) {
  useState(() => tellSettingsList({ has: { winvm: true }, vmOn: environmentId }));
  return children;
}

/** Away as it reads after a stretch away ended at 6:40 PM yesterday, with three decisions made on two threads. */
function BackFromAway({ children }: { children: ReactNode }) {
  useState(() => {
    const ended = new Date(Date.now() - 86_400_000).setHours(18, 40, 0, 0);
    const off = { enabled: false, code: false, work: false, at: ended, by: "mac" };
    awayStore.setState({ hosts: { local: { state: off, decided: { since: ended - 3_600_000, threads: [{ sessionId: "s1", count: 2 }, { sessionId: "s2", count: 1 }] } } }, pending: null });
  });
  return children;
}

/** The page with one of its dialogs or sheets open: presses the control named `press` once the page has drawn. Shoot
 *  such a fixture alone (SETTINGS_PREVIEW=<name>): the dialog covers the window. */
function Pressing({ press, children }: { press: string; children: ReactNode }) {
  useEffect(() => {
    let tries = 0;
    const timer = window.setInterval(() => {
      const control = [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.getAttribute("aria-label") === press || b.textContent?.trim() === press);
      if (control || ++tries > 40) window.clearInterval(timer);
      control?.click();
    }, 50);
    return () => window.clearInterval(timer);
  }, [press]);
  // The page is the stage the open dialog is drawn over, tall enough for it from title to footer.
  return (
    <div data-preview-stage className="min-h-[72rem]">
      {children}
    </div>
  );
}

/** The page as it reads once a host has Work on: a theme for each kind of place. */
function WithWorkOn({ children }: { children: ReactNode }) {
  useState(() => setWorkOn("local", true));
  useEffect(() => () => setWorkOn("local", false), []);
  return children;
}

// Everywhere: the one set saved on the box, the box offline, and two places that keep their own start set.
const ON_THE_BOX = { name: "The box", online: true };
const BOX_OFFLINE = { name: "The box", online: false };
const PLACE_JOB = { id: "w2", name: "Purdue Esports", path: "/srv/agents/work/purdue", git: false, kind: "work", createdAt: 1 };
const PLACE_PROJECT = { id: "p1", name: "settings-2", workspaceId: "w1", path: "/srv/agents/work/temp-code", createdAt: 1 };
const OWN_SET = { provider: "claude", model: "", reasoning: "high", permission: "auto" };
const defaultsAnswer =
  (home: typeof ON_THE_BOX) =>
  (params: unknown): unknown => {
    const workspaceId = (params as { workspaceId?: string | null } | undefined)?.workspaceId ?? null;
    if (workspaceId === null) return { defaults: { provider: "claude", model: "", reasoning: "high", permission: "edits" }, overridden: true, home };
    return { defaults: OWN_SET, overridden: true, home };
  };
const reviewAnswer =
  (beforeMerge: boolean, home: typeof ON_THE_BOX) =>
  (params: unknown): unknown => {
    const settings = { ...DEFAULT_REVIEW_SETTINGS, provider: "claude" as const, model: "claude-opus-5-5", beforeMerge };
    const projectId = (params as { projectId?: string | null } | undefined)?.projectId ?? null;
    return projectId ? { override: { ...settings, beforeMerge: false }, global: settings, settings: { ...settings, beforeMerge: false }, source: "project", home } : { override: null, global: settings, settings, source: "global", home };
  };
const ROUTING = [
  { id: "r1", task: "Bulk edits and migrations", provider: "codex", model: "gpt-6.2-sol", reasoning: "high", enabled: true },
  { id: "r2", task: "Anything a person will see", provider: "claude", model: "claude-opus-5-5", reasoning: "high", enabled: true },
] as const;
const EVERYWHERE_LISTS = { "workspace.list": [WORKSPACE, PLACE_JOB], "project.list": [PLACE_PROJECT] };
// ── Work's pages: three computers, two with Work on, five jobs on the box ──────────────────────────────────────────
// The page's own chunk lands before the first render, as it has once Settings shows it.
await workPageChunk.load();

const WORK_COMPUTERS = [
  { id: "env_box", name: "The box", platform: "linux", routes: [], credentialRef: "env_box" },
  { id: "local", name: "MacBook Pro", platform: "darwin", routes: [], credentialRef: "local" },
  { id: "env_pc", name: "PURDUE-LT", platform: "win32", routes: [], credentialRef: "env_pc" },
];
const workJob = (id: string, name: string, sector: string) => ({ id, name, sector, kind: "work", path: `/srv/work/${name}`, git: false, createdAt: 1, environmentId: "env_box" });
const JOBS = [workJob("j1", "Purdue Esports", "purdue"), workJob("j2", "Cosmic", "cosmic"), workJob("j3", "Hypixel", "hypixel"), workJob("j4", "Unify", "unify"), workJob("j5", "Referee", "ref")];
const GRANT = (id: string, workspaceId: string, label: string, kind = "mail.send") => ({ id, workspaceId, kind, matcher: null, label, madeFrom: { at: "x", id }, routineId: null, createdAt: Date.now() - 86_400_000 * Number(id.slice(1)), removedAt: null });
const tool = (name: string, words: string, rule: "runs" | "held" | "off" | null, changed = false) => ({ tool: name, words, description: "", hints: {}, suggested: "held" as const, rule, changed });
const TOOL_CARDS: ToolRulesCard[] = [
  { addonId: "ad_linear", name: "linear", workspaceId: null, forWork: true, lifeos: false, unreviewed: 1, tools: [tool("list_issues", "List issues", "runs"), tool("create_issue", "Create issue", "held"), tool("update_issue", "Update issue", null), tool("delete_issue", "Delete issue", "off")] },
  { addonId: "ad_figma", name: "figma", workspaceId: null, forWork: true, lifeos: false, unreviewed: 0, tools: [tool("get_file", "Get file", "runs"), tool("post_comment", "Post comment", "held", true)] },
  { addonId: "ad_lifeos", name: "LifeOS", workspaceId: null, forWork: true, lifeos: true, unreviewed: 0, tools: [tool("list_tasks", "List tasks", null)] },
];
const WORK_ANSWERS: Record<string, unknown> = {
  "workspace.list": [WORKSPACE, ...JOBS],
  "defaults.get": { defaults: { provider: "claude", model: "", reasoning: "high", permission: "edits" }, overridden: false },
  "work.outbox.list": { items: [], waiting: 0 },
  "work.outbox.grants": { grants: [GRANT("g1", "j1", "Mail to Sam Ortiz"), GRANT("g2", "j1", "Mail to the Esports staff list"), GRANT("g3", "j2", "Posts to #releases", "teams.post")] },
  "work.outbox.offers": { offers: [] },
  // The grants are the box's: this Mac answers with none of its own.
  "local:work.outbox.grants": { grants: [] },
  "work.outbox.rules": { addons: TOOL_CARDS },
  "work.digest.list": { days: [], rows: [] },
  "work.digest.get": { at: "07:30", zone: "America/Chicago", levels: { results: "digest", meetings: "now" }, nextAt: Date.now() + 20 * 3_600_000 },
};

// Files: OneDrive's libraries on the Mac and in the box's Windows VM, a folder he added, one turned off; three guest links.
const LIB = (id: string, path: string, team: string, library: string | null, over: Partial<TeamsLibrary> = {}): TeamsLibrary => ({ id, host: "h", path, team, library, tenant: "Purdue University", kind: "channels", channels: [], web: null, found: true, ...over });
const DAY = 86_400_000;
const GUEST = (id: string, name: string, title: string, days: number, over: Partial<GuestLinkRow> = {}): GuestLinkRow => ({
  id,
  name,
  source: { at: "lifeos", table: "docs", id: `d${id}` },
  title,
  role: "edit",
  createdAt: Date.now() - 3 * DAY,
  expiresAt: Date.now() + days * DAY,
  revokedAt: null,
  by: "owner",
  lastOpenedAt: Date.now() - DAY,
  open: 0,
  ...over,
});
const FILES_ANSWERS: Record<string, unknown> = {
  ...WORK_ANSWERS,
  "work.office.filesLibraries": {
    host: "h",
    libraries: [
      LIB("l1", "/Users/landon/Library/CloudStorage/OneDrive-Purdue/Esports Staff - Events", "Esports Staff", "Events"),
      LIB("l2", "/Users/landon/Library/CloudStorage/OneDrive-Purdue", "My OneDrive", null, { kind: "mine" }),
      LIB("l3", "/Volumes/Shared/RecWell", "RecWell", null, { kind: "folder", found: false }),
      LIB("l4", "C:/Users/tcuser/Purdue University/Esports Staff - Events", "Esports Staff", "Events", { vm: true }),
    ],
    roots: [{ folder: "/Volumes/Shared/RecWell" }, { folder: "/Users/landon/Library/CloudStorage/OneDrive-Purdue/Esports Staff - Scrims", off: true }],
    off: ["/Users/landon/Library/CloudStorage/OneDrive-Purdue/Esports Staff - Scrims"],
    places: [
      { kind: "folders", state: "ok", account: "landon@purdue.edu" },
      { kind: "vm", state: "ok", account: "landon@purdue.edu" },
    ],
  },
  "work.office.live.libraryDefault": { mode: "live" },
  "work.guests.list": [GUEST("g1", "Sam Ortiz", "Run of show", 6, { open: 1 }), GUEST("g2", "Dana Lee", "Spring LAN budget", 13, { role: "view" }), GUEST("g3", "Maya Chen", "Scrim notes", -2, { revokedAt: Date.now() - DAY })],
};

/**
 * Work as a window with three computers sees it: `on` the computers with Work on, `given` those whose key here is a
 * given computer's (no admin: it may not switch Work there). Put back as it was when the fixture goes.
 */
function AsWorkComputers({ on, given = [], children }: { on: readonly string[]; given?: readonly string[]; children: ReactNode }) {
  useState(() => {
    const statuses = new Map(
      WORK_COMPUTERS.map((c) => [
        c.id,
        { ...registry.statusOf(c.id), transport: "open", lastHello: given.includes(c.id) ? { caps: ["read", "operate", "approve", "device"], key: { id: "laptop" } } : { caps: ["read", "operate", "approve", "admin"] } },
      ]),
    );
    workBefore = { statusOf: registry.statusOf, statuses: registry.statuses, environment: registry.environment };
    // Each computer answers whether Work is on there from `on` (the page reads it before a switch stands).
    overrides = { ...overrides, ...Object.fromEntries(WORK_COMPUTERS.map((c) => [`${c.id}:work.get`, { enabled: on.includes(c.id) }])) };
    Object.assign(registry, {
      statusOf: (id: string) => statuses.get(id) ?? workBefore!.statusOf.call(registry, id),
      statuses: () => statuses,
      environmentsSnapshot: () => WORK_COMPUTERS,
      environment: (id: string) => WORK_COMPUTERS.find((c) => c.id === id),
    });
    for (const c of WORK_COMPUTERS) setWorkOn(c.id, on.includes(c.id));
    resetOwnComputerForTests("MacBook Pro");
    // The Outbox's store holds what its last fixture read: each fixture starts from nothing read.
    resetOutboxStore();
  });
  // A Mac's desktop window: "this Mac" after its own name, and its own On this Mac rows.
  useEffect(
    () => () => {
      for (const c of WORK_COMPUTERS) setWorkOn(c.id, false);
      if (workBefore) Object.assign(registry, workBefore, { environmentsSnapshot: ownEnvironmentsOf });
    },
    [],
  );
  return <AsMac>{children}</AsMac>;
}
let workBefore: Pick<typeof registry, "statusOf" | "statuses" | "environment"> | null = null;
const ownEnvironmentsOf = registry.environmentsSnapshot.bind(registry);


/** Mail as LifeOS answers it (work-kit's fixture client): pictures that ask, two senders whose pictures always show. */
const MAIL_CLIENT = (() => {
  const client = createFixtureMailClient({ write: async ({ run }) => run(), instant: true, threads: corpusThreads(), signatures: corpusSignatures, settings: { pictures: "ask" } });
  return Object.assign(Object.create(client), { useImageSenders: () => ["news@purdue.edu", "events@cosmicgames.com"] }) as typeof client;
})();
/** The same client before LifeOS has answered: the page holds its sections' shape. */
const MAIL_WAITING = Object.assign(Object.create(MAIL_CLIENT), { useMailSettings: () => undefined }) as typeof MAIL_CLIENT;
function MailFixture({ client = MAIL_CLIENT }: { client?: typeof MAIL_CLIENT }) {
  return (
    <>
      <MailClientProvider client={client}>
        <MailSettingsBody />
      </MailClientProvider>
      <SettingSection of="mail.grants">
        <GrantsRow id="mail.grants" />
      </SettingSection>
    </>
  );
}

/** Mail with LifeOS not answering the box: the page's one line with Retry, where the sections would stand. */
function MailDown() {
  useState(() => setLifeosStatus("env_box", { lifeos: { state: "unreachable", since: Date.now() - 600_000, error: "fetch failed" }, keys: [] }));
  return (
    <>
      <MailSection environmentId="env_box" />
      <SettingSection of="mail.grants">
        <GrantsRow id="mail.grants" />
      </SettingSection>
    </>
  );
}

/** Connections as the box and this Mac answer it, PURDUE-LT offline: a sign-out, a fix with a command, the add-in, the VM's sign-ins. */
const hr = (row: Omit<HealthRow, "pillar"> & { pillar?: HealthRow["pillar"] }): HealthRow => ({ pillar: "lifeos", ...row });
const CONNECTION_HOSTS: HostView[] = [
  {
    id: "env_box",
    name: "The box",
    status: "ready",
    report: {
      host: "env_box",
      at: Date.now(),
      rows: [
        hr({ id: "lifeos.signin", group: "LifeOS", title: "LifeOS", state: "working", lifeos: "connected", line: "Signed in as Landon Hale", fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } }),
        hr({ id: "office.vm.office", pillar: "office", group: "Office", title: "Office on the Windows VM", state: "working", line: "Word, Excel and PowerPoint, signed in as lhale@purdue.edu" }),
        hr({ id: "office.vm.onedrive", pillar: "office", group: "Files", title: "OneDrive on the Windows VM", state: "needs-you", line: "Signed out", fix: { kind: "page", label: "Sign in…", page: "windows-vm-sign-in" } }),
        hr({ id: "browser.vm", pillar: "browser", group: "Windows VM", title: "Windows VM", state: "working", line: "Asleep, its disk is ready", until: Date.now() + 83 * DAY }),
        hr({ id: "formats.tool:ffmpeg", pillar: "formats", group: "Tools", title: "ffmpeg", state: "broken", line: "Its files are missing. Install it again with bun scripts/work-tools/install.ts --only ffmpeg" }),
      ],
    },
  },
  {
    id: "local",
    name: "MacBook Pro",
    inLine: "this Mac",
    own: true,
    status: "ready",
    report: {
      host: "local",
      at: Date.now(),
      rows: [
        hr({ id: "lifeos.signin", group: "LifeOS", title: "LifeOS", state: "needs-you", lifeos: "signed-out", line: "Not signed in to LifeOS", fix: { kind: "page", label: "Sign in", page: "lifeos-sign-in" } }),
        hr({ id: "office.live:Purdue University", pillar: "office", group: "Office", title: "Office and Forms for the web, Purdue University", state: "working", line: "Signed in as lhale@purdue.edu", fix: { kind: "run", label: "Sign out", method: "work.office.live.signOut", params: { tenant: "Purdue University" } } }),
      ],
    },
  },
  { id: "env_pc", name: "PURDUE-LT", status: "offline" },
];

/** The digest's page over a store that has read nothing yet: a silent or refusing computer shows its own state. */
function FreshDigest() {
  useState(() => resetDigestStore());
  return <DigestPage />;
}

const workPage = (over: Partial<(typeof PAGES)[string]> & { body: () => ReactNode }) => ({ title: "Work", description: settingsSectionDescription("work"), answers: WORK_ANSWERS, ...over });

/** The project the Editor's language servers run for, by its name. */
const EDITOR_PROJECT = { id: "p1", workspaceId: "w1", name: "CosmicPrisons", mode: "worktree", branch: "tc/cosmic", cwd: "/w", archived: false, createdAt: 1, environmentId: "local" };

/** The updater having read the build this window runs (the store's own setter, as its watch would call it). */
function WithVersion({ children }: { children: ReactNode }) {
  useState(() => (updateStore as unknown as { set: (snapshot: { phase: "idle"; currentVersion: string; canApply: boolean }) => void }).set({ phase: "idle", currentVersion: "1.0.399", canApply: true }));
  return children;
}

const PAGES: Record<
  string,
  {
    title: string;
    description?: ReactNode;
    body: () => ReactNode;
    answers?: Record<string, unknown>;
    service?: ComputerServiceState;
    /** The box's web page: drawn as a browser, with no desktop bridge. */
    web?: boolean;
    /** The computers this window is linked to, and each one's link as the fixture has it. */
    environments?: typeof THREE_COMPUTERS;
    statuses?: Record<string, Partial<EnvironmentStatus>>;
    /** The body draws its own frame (a page that is not a `Page` column). */
    bare?: boolean;
  }
> = {
  "computer-box": {
    title: "The box",
    description: <ComputerLine environmentId="env_box" />,
    environments: THREE_COMPUTERS,
    statuses: { env_box: { lastHello: helloOf(["read", "operate", "approve", "admin"], 397) } },
    body: () => <AsMac><OtherComputerPage environmentId="env_box" /></AsMac>,
  },
  "computer-box-offline": {
    title: "The box",
    environments: THREE_COMPUTERS,
    // Seen two minutes ago, as the link notes on every open: the line says when. The line draws first, so it notes it.
    description: <SeenAgo environmentId="env_box" minutes={2}><ComputerLine environmentId="env_box" /></SeenAgo>,
    statuses: { env_box: { transport: "offline", lastHello: helloOf(["read", "operate", "approve", "admin"], 397) } },
    body: () => (
      <AsMac>
        <WorkSeen environmentId="env_box" on>
          <OtherComputerPage environmentId="env_box" />
        </WorkSeen>
      </AsMac>
    ),
  },
  // The box's own page as /ui draws it: the one computer that serves the page, with its sign-ins and Advanced, no
  // version and no On this Mac (a browser has no "this Mac").
  "computer-box-web": {
    web: true,
    title: "The box",
    description: <ComputerLine environmentId={WEB_ENVIRONMENT_ID} />,
    environments: [{ id: WEB_ENVIRONMENT_ID, name: "The box", routes: [], credentialRef: WEB_ENVIRONMENT_ID }] as unknown as typeof THREE_COMPUTERS,
    // The browser signed in with its own key, "kw": its session is "this browser" in the list.
    statuses: { [WEB_ENVIRONMENT_ID]: { lastHello: helloOf(["read", "operate", "approve", "admin"], 397, "kw") } },
    answers: {
      ...Object.fromEntries(Object.entries(ANSWERS).filter(([key]) => key.startsWith("env_box:")).map(([key, value]) => [`${WEB_ENVIRONMENT_ID}:${key.slice("env_box:".length)}`, value])),
      [`${WEB_ENVIRONMENT_ID}:remote.sessions.list`]: [
        ...(ANSWERS["env_box:remote.sessions.list"] as unknown[]),
        { id: "s2", keyId: "kw", keyName: "Landon", caps: ["read", "operate", "approve", "admin"], userAgent: "Mozilla/5.0 Version/18.0 Safari/605.1.15", createdAt: 1, lastSeenAt: Date.now() - 1000, expiresAt: Date.now() + 1e9 },
      ],
    },
    body: () => <OtherComputerPage environmentId={WEB_ENVIRONMENT_ID} advancedOpen />,
  },
  "computer-box-advanced": {
    title: "The box",
    description: <ComputerLine environmentId="env_box" />,
    environments: THREE_COMPUTERS,
    statuses: { env_box: { lastHello: helloOf(["read", "operate", "approve", "admin"], 397) } },
    body: () => <AsMac><OtherComputerPage environmentId="env_box" advancedOpen /></AsMac>,
  },
  "computer-box-key": {
    title: "The box",
    description: <ComputerLine environmentId="env_box" />,
    environments: THREE_COMPUTERS,
    statuses: { env_box: { lastHello: helloOf(["read", "operate"], 397) } },
    body: () => <AsMac><OtherComputerPage environmentId="env_box" /></AsMac>,
  },
  "computer-pc": {
    title: "PURDUE-LT",
    description: <ComputerLine environmentId="env_pc" />,
    environments: THREE_COMPUTERS,
    statuses: { env_pc: { lastHello: helloOf(["read", "operate"], 399) } },
    body: () => <AsMac><OtherComputerPage environmentId="env_pc" /></AsMac>,
  },
  general: { title: "General", body: () => <AsMac><GeneralPage /></AsMac> },
  here: { title: "Threads on this Mac", body: () => <AsMac><ThreadsPage /></AsMac> },
  sync: { title: "Sync", description: <SyncLine />, environments: THREE_COMPUTERS, body: () => <AsMac><SyncPage /></AsMac> },
  publish: { title: "Publish", description: settingsSectionDescription("publish"), body: () => <AsMac><PublishPage /></AsMac> },
  "publish-running": {
    title: "Publish",
    description: settingsSectionDescription("publish"),
    answers: {
      "host.publishStatus": { ...PUBLISH, phase: "running", target: "1.0.400", startedAt: Date.now() - MINUTE, stoppable: true },
      // The job's log as the host keeps it: the page tails it while the publish runs.
      "host.log": {
        text: "Building 1.0.400 from ~/IdeaProjects/temp-code\nSigning Docket.app\nNotarizing (this takes a few minutes)\n",
        status: { job: "publish", phase: "running", target: "1.0.400", startedAt: Date.now() - MINUTE, finishedAt: null, exit: null, stoppable: true },
      },
    },
    body: () => <AsMac><PublishPage /></AsMac>,
  },
  winvm: { title: "Windows VM", description: settingsSectionDescription("winvm"), environments: THREE_COMPUTERS, body: () => <WithVmOn environmentId="env_box"><WinvmPage /></WithVmOn> },
  sharing: { title: "Sharing", description: settingsSectionDescription("sharing"), environments: THREE_COMPUTERS, body: () => <AsMac><SharingPage /></AsMac> },
  "sharing-advanced": {
    title: "Sharing",
    description: settingsSectionDescription("sharing"),
    environments: THREE_COMPUTERS,
    body: () => <AsMac><SharingPage advancedOpen /></AsMac>,
  },
  "sharing-may": {
    // The sheet's body as its own page: a portal is not in a static shot (MaySheet.dom.test.tsx holds the sheet).
    title: "What the box may do on this Mac",
    environments: THREE_COMPUTERS,
    body: () => <AsMac><MayBody host={BRIDGE[0] as MacBridgeHostPolicy} name="the box" mac="this Mac" /></AsMac>,
  },
  updates: {
    title: "Updates",
    description: settingsSectionDescription("updates"),
    environments: THREE_COMPUTERS,
    statuses: { env_box: { lastHello: helloOf(["read", "operate", "approve", "admin"], 397) }, env_pc: { transport: "offline" } },
    // A Mac's window: Updates is a desktop page, and this Mac is "this Mac" in its lines.
    body: () => <AsMac><WithVersion><UpdatesPage onOpenWhatsNew={() => {}} /></WithVersion></AsMac>,
  },
  away: { title: "Away", description: settingsSectionDescription("away"), body: () => <WithWorkOn><BackFromAway><AwayPage /></BackFromAway></WithWorkOn> },
  defaults: {
    title: "New threads",
    description: <HomeLine page="defaults" />,
    body: () => <ThreadDefaultsPage />,
    answers: { ...EVERYWHERE_LISTS, "defaults.get": defaultsAnswer(ON_THE_BOX), "plans.get": { settings: DEFAULT_PLAN_SETTINGS, overridden: false, home: ON_THE_BOX } },
  },
  "defaults-offline": {
    title: "New threads",
    description: <HomeLine page="defaults" />,
    body: () => <ThreadDefaultsPage />,
    answers: { "defaults.get": { defaults: { provider: "claude", model: "", reasoning: "high", permission: "edits" }, overridden: false, home: BOX_OFFLINE }, "plans.get": { settings: DEFAULT_PLAN_SETTINGS, overridden: false, home: BOX_OFFLINE } },
  },
  appearance: { title: "Appearance", body: () => <AppearancePage /> },
  "appearance-work": { title: "Appearance", body: () => <WithWorkOn><AppearancePage /></WithWorkOn> },
  editor: { title: "Editor", body: () => <AsMac><EditorPage /></AsMac>, answers: { "project.list": [EDITOR_PROJECT] } },
  // The IntelliJ engine downloaded, its licence not yet read: Read the licence… in the engine's row.
  "editor-licence": {
    title: "Editor",
    body: () => <AsMac><EditorPage /></AsMac>,
    answers: {
      "project.list": [EDITOR_PROJECT],
      "doctor.get": { ...(ANSWERS["doctor.get"] as object), java: { found: true, version: "21.0.4", jdtls: true, path: "/usr/lib/jvm/java-21", ideaServer: { dist: true, accepted: false, build: "263.2689" } } },
    },
  },
  keybindings: { title: "Shortcuts", body: () => <KeybindingsPage /> },
  "keybindings-work": { title: "Shortcuts", body: () => <AsMac><WithWorkOn><KeybindingsPage /></WithWorkOn></AsMac> },
  appshots: { title: "Appshots", description: settingsSectionDescription("appshots"), body: () => <AsMac><AppshotsPage /></AsMac> },
  orchestration: {
    title: "Subagents",
    description: <HomeLine page="orchestration" />,
    body: () => <OrchestrationPage />,
    answers: { "rules.get": { rules: { ...withProbedDefaults(DEFAULT_RULES), routing: ROUTING }, overridden: true, home: ON_THE_BOX } },
  },
  // AI accounts' own page is the Accounts page (DOCKET's, aliax/pages.tsx): the fixture is the one row Settings adds.
  // AI accounts is the Accounts page (DOCKET's, aliax/pages.tsx, with its own previews), then the one row Settings adds,
  // at the Accounts page's own inset: the page stands here as its title and a line saying it is not drawn.
  accounts: {
    title: "AI accounts",
    bare: true,
    body: () => (
      <WithWorkOn>
        <Page title="AI accounts" description={settingsSectionDescription("accounts")} width="table">
          <PageEmpty>The Accounts page's own rows draw here. This preview does not mount them.</PageEmpty>
        </Page>
        <AccountsFoot />
      </WithWorkOn>
    ),
  },
  "orchestration-models": {
    title: "Subagents",
    description: <HomeLine page="orchestration" />,
    body: () => <Pressing press="Models agents may run on"><OrchestrationPage /></Pressing>,
    answers: { "rules.get": { rules: { ...withProbedDefaults(DEFAULT_RULES), routing: ROUTING }, overridden: true, home: ON_THE_BOX } },
  },
  "orchestration-rule": {
    title: "Subagents",
    description: <HomeLine page="orchestration" />,
    body: () => <Pressing press="Edit rule: Anything a person will see"><OrchestrationPage /></Pressing>,
    answers: { "rules.get": { rules: { ...withProbedDefaults(DEFAULT_RULES), routing: ROUTING }, overridden: true, home: ON_THE_BOX } },
  },
  "defaults-places": {
    title: "New threads",
    description: <HomeLine page="defaults" />,
    body: () => <Pressing press="Different in 2 places"><ThreadDefaultsPage /></Pressing>,
    answers: { ...EVERYWHERE_LISTS, "defaults.get": defaultsAnswer(ON_THE_BOX), "plans.get": { settings: DEFAULT_PLAN_SETTINGS, overridden: false, home: ON_THE_BOX } },
  },
  "addons-add": { title: "Add-ons", description: <HomeLine page="addons" />, body: () => <Pressing press="Add…"><AddonsPage /></Pressing> },
  "addons-edit": { title: "Add-ons", description: <HomeLine page="addons" />, body: () => <Pressing press="Edit github"><AddonsPage /></Pressing> },
  "skills-edit": { title: "Skills", description: <HomeLine page="skills" />, body: () => <Pressing press="Edit release-notes"><SkillsPage /></Pressing> },
  "orchestration-offline": {
    title: "Subagents",
    description: <HomeLine page="orchestration" />,
    body: () => <OrchestrationPage />,
    answers: { "rules.get": { rules: { ...withProbedDefaults(DEFAULT_RULES), routing: ROUTING }, overridden: true, home: BOX_OFFLINE } },
  },
  reviews: { title: "Reviews", description: <HomeLine page="reviews" />, body: () => <ReviewsPage />, answers: { ...EVERYWHERE_LISTS, "review.get": reviewAnswer(true, ON_THE_BOX) } },
  "reviews-off": { title: "Reviews", description: <HomeLine page="reviews" />, body: () => <ReviewsPage />, answers: { "review.get": reviewAnswer(false, ON_THE_BOX) } },
  workspace: {
    title: "temp-code",
    description: "/srv/agents/work/temp-code, on this Mac",
    // A Mac's window: the page's computer is this Mac, by its name.
    body: () => <AsMac><WorkspacePage workspaceId="w1" /></AsMac>,
    answers: { "project.list": [{ id: "p1", workspaceId: "w1", name: "settings-2", mode: "worktree", branch: "tc/settings-2", cwd: "/w", archived: false, createdAt: 1 }, { id: "p2", workspaceId: "w1", name: "unread-marks", mode: "worktree", branch: "tc/unread-marks", cwd: "/w", archived: false, createdAt: 1 }] },
  },
  addons: { title: "Add-ons", description: <HomeLine page="addons" />, body: () => <AddonsPage /> },
  skills: { title: "Skills", description: <HomeLine page="skills" />, body: () => <SkillsPage /> },
  computer: { title: "Computer use", description: settingsSectionDescription("computer"), body: () => <ComputerPage /> },
  // Work on for its computer: its job, the LifeOS job its threads may read.
  "workspace-work": {
    title: "temp-code",
    description: "/srv/agents/work/temp-code, on this Mac",
    body: () => (
      <AsMac>
        <WithWorkOn>
          <WorkspacePage workspaceId="w1" job={<CodeWorkspaceSector workspaceId="w1" />} />
        </WithWorkOn>
      </AsMac>
    ),
    answers: { "work.lifeos.status": { lifeos: { state: "connected", ownerId: "owner", since: 0 }, keys: [] } },
  },
  // Three archived threads this window never loaded, asked of the computer by the page itself.
  archive: {
    title: "Archive",
    description: settingsSectionDescription("archive"),
    body: () => <AsMac><ArchivePage onOpenSession={() => {}} onArchiveSession={() => {}} onDeleteSession={() => {}} onRestoreProject={() => {}} onDeleteProject={() => {}} /></AsMac>,
    answers: {
      "project.list": [PROJECT],
      "session.list": [
        { id: "a1", title: "Fix the rail's unread dot", provider: "claude", archived: true, projectId: "p1", cwd: "/w", status: "idle", createdAt: 1, updatedAt: Date.UTC(2026, 10, 24, 15) },
        { id: "a2", title: "Venue for the spring LAN", provider: "codex", archived: true, cwd: "/home/agents/work/Purdue Esports", status: "idle", createdAt: 1, updatedAt: Date.UTC(2026, 10, 20, 15) },
        { id: "a3", title: "Bump the work-kit pin", provider: "claude", archived: true, projectId: "p1", cwd: "/w", status: "idle", createdAt: 1, updatedAt: Date.UTC(2026, 10, 18, 15) },
      ],
    },
  },
  // A project's settings sheet, over the workspace page it opens from.
  project: {
    title: "temp-code",
    description: "/srv/agents/work/temp-code, on this Mac",
    body: () => <AsMac><ProjectSheet /></AsMac>,
    answers: { "project.list": [PROJECT], "turnpass.get": { verify: true, build: false, commit: "push" } },
  },
  // A Mac's window, so this Mac is its own row and its bridge is read.
  job: { title: JOB.name, description: "Purdue, on the box", body: () => <AsMac><JobPage workspace={JOB} /></AsMac>, answers: JOB_ANSWERS },
  "computer-empty": {
    title: "Computer use",
    description: settingsSectionDescription("computer"),
    body: () => <ComputerPage />,
    answers: { "computer.settings.get": { ...COMPUTER_SETTINGS, apps: [] }, "computer.permissions": { accessibility: true, screenRecording: true } },
    service: { ...COMPUTER_UP, state: "idle", permissions: null },
  },
  "computer-down": {
    title: "Computer use",
    description: settingsSectionDescription("computer"),
    body: () => <ComputerPage />,
    answers: { "computer.settings.get": { ...COMPUTER_SETTINGS, apps: COMPUTER_SETTINGS.apps.slice(1, 2) } },
    service: COMPUTER_DOWN,
  },
  "addons-empty": {
    title: "Add-ons",
    description: <HomeLine page="addons" />,
    body: () => <AddonsPage />,
    answers: { "addons.list": { addons: [], status: {}, home: null }, "addons.grant.list": { grants: [] } },
  },
  "skills-empty": { title: "Skills", description: <HomeLine page="skills" />, body: () => <SkillsPage />, answers: { "skills.list": { skills: [], home: null } } },
  "addons-offline": {
    title: "Add-ons",
    description: <HomeLine page="addons" />,
    body: () => <AddonsPage />,
    answers: { "addons.list": { ...STORE_ANSWERS["addons.list"], home: OFFLINE } },
  },
  "work-off": workPage({ body: () => <AsWorkComputers on={[]}><WorkPage /></AsWorkComputers> }),
  work: workPage({ body: () => <AsWorkComputers on={["env_box", "local"]} given={["env_pc"]}><WorkPage /></AsWorkComputers> }),
  "work-given": workPage({ body: () => <AsWorkComputers on={["env_box", "env_pc"]} given={["env_box", "env_pc"]}><WorkPage /></AsWorkComputers> }),
  "work-grants": workPage({ body: () => <AsWorkComputers on={["env_box"]}><WorkPage /><StoreGrantsSheet open onOpenChange={() => {}} /></AsWorkComputers> }),
  "work-tools": workPage({ body: () => <AsWorkComputers on={["env_box"]}><WorkPage /><ToolsSheet open onOpenChange={() => {}} /></AsWorkComputers> }),
  "work-confirm": workPage({
    body: () => (
      <AsWorkComputers on={["env_box", "local"]}>
        <WorkPage />
        <ConfirmDialog {...workOffAsk("the box", 5)} confirmLabel="Turn off" onCancel={() => {}} onConfirm={() => {}} onDone={() => {}} />
      </AsWorkComputers>
    ),
  }),
  digest: { title: "Digest", description: settingsSectionDescription("digest"), answers: WORK_ANSWERS, body: () => <AsWorkComputers on={["env_box", "local"]}><FreshDigest /></AsWorkComputers> },
  "digest-given": { title: "Digest", description: settingsSectionDescription("digest"), answers: WORK_ANSWERS, body: () => <AsWorkComputers on={["env_box", "local"]} given={["env_box", "local"]}><FreshDigest /></AsWorkComputers> },
  connections: {
    title: "Connections",
    description: settingsSectionDescription("connections"),
    answers: WORK_ANSWERS,
    body: () => (
      <AsWorkComputers on={["env_box", "local"]}>
        <ConnectionsView hosts={CONNECTION_HOSTS} onRecheck={() => {}} />
      </AsWorkComputers>
    ),
  },
  mail: { title: "Mail", description: settingsSectionDescription("mail"), answers: WORK_ANSWERS, body: () => <AsWorkComputers on={["env_box"]}><MailFixture /></AsWorkComputers> },
  "mail-loading": { title: "Mail", description: settingsSectionDescription("mail"), answers: WORK_ANSWERS, body: () => <AsWorkComputers on={["env_box"]}><MailFixture client={MAIL_WAITING} /></AsWorkComputers> },
  "mail-down": { title: "Mail", description: settingsSectionDescription("mail"), answers: WORK_ANSWERS, body: () => <AsWorkComputers on={["env_box"]}><MailDown /></AsWorkComputers> },
  "connections-loading": {
    title: "Connections",
    description: settingsSectionDescription("connections"),
    answers: WORK_ANSWERS,
    body: () => (
      <AsWorkComputers on={["env_box", "local"]}>
        <ConnectionsView hosts={[{ id: "env_box", name: "The box", status: "checking" }, { id: "local", name: "MacBook Pro", inLine: "this Mac", own: true, status: "checking" }]} onRecheck={() => {}} />
      </AsWorkComputers>
    ),
  },
  "connections-refused": {
    title: "Connections",
    description: settingsSectionDescription("connections"),
    answers: WORK_ANSWERS,
    body: () => (
      <AsWorkComputers on={["env_box", "local"]}>
        <ConnectionsView
          hosts={[
            { id: "env_box", name: "The box", status: "failed", silent: true },
            { id: "local", name: "MacBook Pro", inLine: "this Mac", own: true, status: "failed", error: "Work is off on this Mac" },
          ]}
          onRecheck={() => {}}
        />
      </AsWorkComputers>
    ),
  },
  files: { title: "Files", answers: FILES_ANSWERS, body: () => <AsWorkComputers on={["env_box", "local"]}><FilesPage /></AsWorkComputers> },
  "files-guests": { title: "Files", answers: FILES_ANSWERS, body: () => <AsWorkComputers on={["env_box", "local"]}><FilesPage guestsOpen /></AsWorkComputers> },
  "skills-offline": {
    title: "Skills",
    description: <HomeLine page="skills" />,
    body: () => <SkillsPage />,
    answers: { "skills.list": { ...STORE_ANSWERS["skills.list"], home: OFFLINE } },
  },
};

/**
 * The pages held to the map (lib/settingsMapGuard.dom.test.tsx), each with the fixtures that between them draw every
 * row the map lists for it; `elsewhere` names rows a fixture cannot draw here (a dialog's, a sheet's), each held by
 * its own test. A page joins as it is rebuilt on `SettingRow`; at the end of Settings 2 it is every page.
 */
export const GUARDED_PAGES: Partial<Record<SettingPage, { previews: (keyof typeof PAGES)[]; elsewhere?: string[] }>> = {
  away: { previews: ["away"] },
  general: { previews: ["general"] },
  updates: { previews: ["updates"] },
  appearance: { previews: ["appearance", "appearance-work"] },
  editor: { previews: ["editor", "editor-licence"] },
  // The Appshot's row is a Mac window's alone: Keybindings.dom.test.tsx holds it.
  keybindings: { previews: ["keybindings", "keybindings-work"] },
  appshots: { previews: ["appshots"] },
  computer: { previews: ["computer", "computer-down"] },
  here: { previews: ["here"] },
  sync: { previews: ["sync"] },
  publish: { previews: ["publish"] },
  winvm: { previews: ["winvm"] },
  // Set up from this Mac is the PC's; the box's version, the Work row and the rest are the box's.
  "computer:*": { previews: ["computer-box", "computer-pc"] },
  // What a computer may do on this Mac is its sheet's: drawn open by "sharing-may", held by MaySheet.dom.test.tsx.
  sharing: {
    previews: ["sharing"],
    elsewhere: ["sharing.files", "sharing.apps", "sharing.devSites", "sharing.folders", "sharing.commands", "sharing.threads", "sharing.driven", "sharing.running", "sharing.allowed"],
  },
  defaults: { previews: ["defaults"] },
  reviews: { previews: ["reviews", "reviews-off"] },
  orchestration: { previews: ["orchestration"] },
  // The accounts themselves are the Accounts page's rows (aliax/pages.tsx), which this preview does not mount.
  accounts: { previews: ["accounts"], elsewhere: ["accounts.list"] },
  addons: { previews: ["addons"] },
  skills: { previews: ["skills"] },
  job: { previews: ["job"] },
  workspace: { previews: ["workspace", "workspace-work"] },
  archive: { previews: ["archive"] },
  work: { previews: ["work-off", "work", "work-given", "work-grants", "work-tools", "work-confirm"] },
  digest: { previews: ["digest", "digest-given"] },
  files: { previews: ["files", "files-guests"] },
  mail: { previews: ["mail", "mail-loading", "mail-down"] },
  connections: { previews: ["connections", "connections-loading", "connections-refused"] },
};

/** The sheet once the catalog knows its workspace, as it always does in the app before a project's row can open it. */
function ProjectSheet() {
  const workspace = useWorkspaces().find((w) => w.id === "w1");
  return workspace ? (
    <>
      {/* The preview lays a portal with a side in the flow, as a popover: a sheet is fixed to the window, so its box stands in for one. */}
      <style>{".preview-portal:has([data-slot=sheet-content]) { min-height: 1480px; overflow: hidden; }"}</style>
      <ProjectSettingsDialog project={PROJECT} workspace={workspace} onClose={() => {}} />
    </>
  ) : null;
}

/** Thread defaults' "New threads start on" asks only once a second host is saved. */
const TWO_HOSTS = [
  { id: "local", name: "This Mac", routes: [], credentialRef: "local" },
  { id: "env_box", name: "The box", routes: [], credentialRef: "env_box" },
];
const ONE_HOST = TWO_HOSTS.slice(0, 1);
const ownEnvironments = registry.environmentsSnapshot.bind(registry);

export function SettingsPagePreview({ page, host }: { page: keyof typeof PAGES; host: HostMode }) {
  useState(() => {
    // A Mac's desktop window unless the fixture says otherwise: the shot page has no bridge of its own, which every
    // page would read as the box's web page (isWebMode), naming no computer as this Mac.
    const api = (window as unknown as { api?: Record<string, unknown> }).api;
    if (!api && !PAGES[page].web) (window as unknown as { api: unknown }).api = { platform: "darwin" };
    const linked = PAGES[page].environments;
    Object.assign(registry, { environmentsSnapshot: linked ? () => linked : page === "defaults" || page === "defaults-places" || page === "updates" ? () => TWO_HOSTS : page === "job" ? () => JOB_HOSTS : page === "archive" ? () => ONE_HOST : ownEnvironments });
    statuses = PAGES[page].statuses ?? {};
    silentComputers = new Set(Object.entries(statuses).flatMap(([id, st]) => (st.transport && st.transport !== "open" ? [id] : [])));
    deployDriftStore.setState({ master: { release: 399, version: "1.0.399" } as never });
    statusCache.clear();
    resetPageHomesForTests();
    prepare(host, PAGES[page].answers, PAGES[page].service);
    // A job on the box: the store reads its start set over the box's own link.
    if (page === "job") workspaceStore.attach({ ...link, environmentId: "env_box" } as Link);
  });
  const { title, description, body, bare } = PAGES[page];
  if (bare) return <FailuresSaidOnce>{body()}</FailuresSaidOnce>;
  return (
    <Page title={title} description={description}>
      <FailuresSaidOnce>{body()}</FailuresSaidOnce>
    </Page>
  );
}
