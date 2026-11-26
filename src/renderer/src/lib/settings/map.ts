import { keyCaps } from "../keys";
import type { StaticSettingsSectionId } from "../settings";

/** The Mac's command key, as the old Appshots row named it. */
const [MAC_COMMAND] = keyCaps("mod", true);

/**
 * Every row Settings draws, in one list (docs/agents/settings.md "The map"): where it lives now, what it is called,
 * what it was called, what a change reaches and where it is kept. It is the search index (lib/settings/search.ts),
 * the one source of a row's name (`SettingRow` draws its title from here, so a page and the search never disagree),
 * the table "where each old setting went" (`bun scripts/settings-map.ts`) and what two guards hold: a page draws no
 * row the map lacks and the map lists no row its page does not draw (lib/settingsMapGuard.dom.test.tsx).
 *
 * A name may hold `{mac}` ("this Mac", "this PC" on Windows), `{computer}` (the other computer the row is about, as
 * it reads mid-line), `{n}` (a count) and `{version}`: `settingWords` fills them.
 */

/** The page a row is on: a fixed page, any other computer's page, any job's or any code workspace's. */
export type SettingPage = StaticSettingsSectionId | "computer:*" | "job" | "workspace";

/** What a change reaches. */
export type SettingScope =
  /** This app on this computer (a window's own preference). */
  | "app"
  /** This computer: every thread and window on it. */
  | "here"
  /** One set kept on the box, read by every computer. */
  | "every"
  /** The other computer whose page the row is on. */
  | "computer"
  /** Each computer with Work on, kept the same by design. */
  | "work"
  /** One job, or one code workspace. */
  | "workspace"
  /** LifeOS: the same on every device. */
  | "lifeos";

/** Where it is kept: this app's localStorage, a computer's own database or files, the one copy on the box, the
 *  workspace's row on its computer, LifeOS, or nowhere (an act, a fact, an open row). */
export type SettingStore = "ls" | "host" | "box" | "ws" | "lifeos" | "none";

/** `setting` a stored value with one control; `act` a button that does a thing; `open` a row that opens a dialog, a
 *  sheet or another page; `fact` words alone; `list` a section of rows named by what they hold (devices, add-ons). */
export type SettingKind = "setting" | "act" | "open" | "fact" | "list";

export type SettingEntry = {
  id: string;
  page: SettingPage;
  /** The section's heading; "" for a page's first, unnamed section. */
  section: string;
  title: string;
  /** Its old homes, each "Page › Section › Name" as Settings said it before Settings 2. */
  was: readonly string[];
  scope: SettingScope;
  store: SettingStore;
  kind?: SettingKind;
};

const e = (
  id: string,
  page: SettingPage,
  section: string,
  title: string,
  scope: SettingScope,
  store: SettingStore,
  was: readonly string[] = [],
  kind?: SettingKind,
): SettingEntry => ({ id, page, section, title, was, scope, store, ...(kind ? { kind } : {}) });

export const SETTINGS_MAP: readonly SettingEntry[] = [
  // ── This Mac ─────────────────────────────────────────────────────────
  e("general.promptTop", "general", "Transcript", "Keep my prompt at the top", "app", "ls", ["General › Transcript › Prompt at the top"]),
  e("general.enter", "general", "Composer", "Enter while a thread is working", "app", "ls", ["General › Composer › Enter during a turn"]),
  e("general.picker", "general", "Composer", "Model picker shows", "app", "ls", ["Thread defaults › Model picker"], "open"),
  e("general.sounds", "general", "Sounds and power", "Sounds", "app", "ls", ["General › Extras › Sounds"]),
  e("general.awake", "general", "Sounds and power", "Keep {mac} awake", "here", "host", ["Hosts › This Mac › Keep awake"]),
  e("general.linear", "general", "Inbox", "Linear", "here", "host", ["General › Linear › API key"]),
  e("general.linearTeams", "general", "Inbox", "Linear teams in the inbox", "app", "ls", ["General › Teams in the inbox"], "open"),

  e("appearance.theme", "appearance", "Theme", "Theme", "app", "ls", ["Appearance › Theme"]),
  e("appearance.code", "appearance", "Theme", "Code", "app", "ls", ["Appearance › Theme › Code"]),
  e("appearance.work", "appearance", "Theme", "Work", "app", "ls", ["Appearance › Theme › Work"]),
  e("appearance.textSize", "appearance", "Size and motion", "Text size", "app", "ls", ["View menu › Zoom In, Zoom Out, Actual Size"]),
  e("appearance.editorSize", "appearance", "Size and motion", "Editor text size", "app", "ls", ["Appearance › Editor font size"]),
  e("appearance.motion", "appearance", "Size and motion", "Motion", "app", "ls", ["Appearance › Motion"]),

  e("editor.autoSave", "editor", "Saving", "Save as I type", "app", "ls", ["Editor › Auto save"]),
  e("editor.formatJava", "editor", "Saving", "Format Java and Kotlin on save", "app", "ls", ["Editor › Java formatting"]),
  e("editor.formatWeb", "editor", "Saving", "Format TypeScript and JavaScript on save", "app", "ls", ["Editor › TypeScript and JavaScript formatting"]),
  e("editor.inline", "editor", "Suggestions", "Inline suggestions", "app", "ls", ["Editor › Completions › Ghost text"]),
  e("editor.openIn", "editor", "Other editors", "Open files in", "here", "host", ["Editor › Open files in › External editor"]),
  e("editor.jdk", "editor", "Java on {mac}", "JDK", "here", "none", ["Editor › Java", "Editor › Language servers"], "fact"),
  e("editor.intellij", "editor", "Java on {mac}", "IntelliJ engine", "here", "host", ["Editor › Java › IntelliJ engine", "Editor › Language servers"]),

  e("keys.find", "keybindings", "", "Find a shortcut", "app", "none", ["Keybindings › Filter"], "act"),
  e("keys.capture", "keybindings", "From any app", "Open capture", "here", "host", ["Work › Capture › Capture key"]),
  e("keys.appshot", "keybindings", "From any app", "Appshot", "here", "none", [], "fact"),
  e("keys.groups", "keybindings", "", "Shortcuts", "app", "none", ["Keybindings"], "list"),

  e("updates.version", "updates", "", "Docket {version}", "here", "none", ["General › About"], "act"),
  e("updates.notes", "updates", "", "Release notes", "here", "none", ["General › About › Release notes"], "act"),
  e("updates.quick", "updates", "", "Quick updates from", "app", "host", ["Hosts › Release › Code updates"]),
  e("updates.others", "updates", "Other computers", "Other computers", "computer", "none", [], "list"),

  e("appshots.on", "appshots", "", "Appshots", "here", "host", [`Appshots › Double-${MAC_COMMAND} capture`]),
  e("appshots.into", "appshots", "", "Add the window to", "here", "host", ["Appshots › Destination"]),
  e("appshots.sound", "appshots", "", "Shutter sound", "here", "host", ["Appshots › Shutter sound"]),

  e("computer.helper", "computer", "", "Computer use helper", "here", "none", [], "act"),
  e("computer.wait", "computer", "", "Wait after my last input", "here", "host", ["Computer use › Take the screen after"]),
  e("computer.front", "computer", "", "When a step needs an app in front", "here", "host", ["Computer use › When a step needs an app in front"]),
  e("computer.pictures", "computer", "", "Keep pictures of each step", "here", "host", ["Computer use › Keep pictures of the window"]),
  e("computer.watch", "computer", "", "Let my other devices watch", "here", "host", ["Computer use › Watch from my other devices"]),
  e("computer.own", "computer", "Who may use {mac}'s apps", "Threads on {mac}", "here", "none", [], "fact"),
  e("computer.others", "computer", "Who may use {mac}'s apps", "Other computers", "here", "none", ["Hosts › Mac bridge › Computer use"], "list"),
  e("computer.accessibility", "computer", "macOS permissions", "Accessibility", "here", "none", ["Computer use › Permissions", "Appshots › Permissions"], "act"),
  e("computer.screen", "computer", "macOS permissions", "Screen Recording", "here", "none", ["Computer use › Permissions", "Appshots › Permissions"], "act"),
  e("computer.apps", "computer", "Apps it has learned", "Apps it has learned", "here", "host", ["Computer use › Apps"], "list"),
  e("computer.forgetAll", "computer", "Apps it has learned", "Forget all…", "here", "host", [], "act"),

  e("here.atOnce", "here", "", "Threads at once", "here", "host", ["Hosts › This Mac › Running threads"]),
  e("here.stuck", "here", "", "Tell me a thread is stuck after", "here", "host", ["Hosts › This Mac › Stuck after"]),
  e("here.attachment", "here", "", "Largest attachment", "here", "host", ["Hosts › This Mac › Attachment limit"]),
  e("here.apps", "here", "Agent apps", "Agent apps", "here", "none", ["Providers"], "list"),
  e("here.devices", "here", "Simulators and phones", "Simulators and phones", "here", "none", ["Hosts › Devices"], "list"),

  e("sharing.signIns", "sharing", "Who can sign in to {mac}", "Who can sign in to {mac}", "here", "host", ["Hosts › Clients"], "list"),
  e("sharing.add", "sharing", "Who can sign in to {mac}", "Add…", "here", "host", ["Hosts › Clients › Pair a device…", "Hosts › Clients › New key…"], "act"),
  e("sharing.may", "sharing", "What other computers may do on {mac}", "What other computers may do on {mac}", "here", "none", ["Hosts › Mac bridge for a host"], "list"),
  e("sharing.files", "sharing", "What {computer} may do on {mac}", "Files and commands", "here", "host", ["Hosts › Mac bridge for a host › Access"]),
  e("sharing.apps", "sharing", "What {computer} may do on {mac}", "Use {mac}'s apps", "here", "host", ["Hosts › Mac bridge for a host › Computer use"]),
  e("sharing.devSites", "sharing", "What {computer} may do on {mac}", "Its dev sites open here", "here", "host", ["Hosts › Mac bridge › Settings… › Dev server forwarding", "Hosts › Mac bridge for a host › Settings…"]),
  e("sharing.folders", "sharing", "What {computer} may do on {mac}", "Folders it reads without asking", "here", "host", ["Hosts › Mac bridge › Settings… › Shared folders"], "list"),
  e("sharing.commands", "sharing", "What {computer} may do on {mac}", "Its commands here at once", "here", "host", ["Hosts › Mac bridge › Settings… › Commands at once"]),
  e("sharing.threads", "sharing", "What {computer} may do on {mac}", "Its threads here at once", "here", "host", ["Hosts › Mac bridge › Settings… › Threads at once"]),
  e("sharing.driven", "sharing", "What {computer} may do on {mac}", "Apps it drives at once", "here", "host", ["Hosts › Mac bridge › Settings… › Computer sessions at once"]),
  e("sharing.running", "sharing", "What {computer} may do on {mac}", "Running now", "here", "none", ["Hosts › Mac bridge › Running"], "list"),
  e("sharing.allowed", "sharing", "What {computer} may do on {mac}", "Allowed until Docket quits", "here", "none", ["Hosts › Remembered approvals"], "list"),
  e("sharing.reach", "sharing", "Advanced", "Let other devices reach {mac}", "here", "host", ["Hosts › This Mac › Remote access"]),
  e("sharing.port", "sharing", "Advanced", "Port", "here", "host", ["Hosts › This Mac › Port"]),
  e("sharing.address", "sharing", "Advanced", "Web address", "here", "host", ["Hosts › This Mac › Public origin"]),
  e("sharing.load", "sharing", "Advanced", "Pause other computers' commands above load", "here", "host", ["Hosts › This Mac › Load limit"]),
  e("sharing.id", "sharing", "Advanced", "Computer ID", "here", "none", ["Hosts › This Mac › Copy environment id"], "act"),

  e("publish.new", "publish", "", "New release", "here", "none", ["Hosts › Release › Mac release"], "act"),
  e("publish.folder", "publish", "", "Release folder", "here", "host", ["Hosts › Release › Release checkout"]),

  // ── Every computer ───────────────────────────────────────────────────
  e("defaults.app", "defaults", "Start with", "Agent app", "every", "box", ["Thread defaults › New threads › Provider"]),
  e("defaults.model", "defaults", "Start with", "Model", "every", "box", ["Thread defaults › New threads › Model"]),
  e("defaults.effort", "defaults", "Start with", "Effort", "every", "box", ["Thread defaults › New threads › Reasoning"]),
  e("defaults.access", "defaults", "Start with", "Access", "every", "box", ["Thread defaults › New threads › Permission mode"]),
  e("defaults.startOn", "defaults", "Start with", "Linked projects start on", "every", "box", ["Thread defaults › New threads start on"]),
  e("defaults.different", "defaults", "Start with", "Different in {n} places", "workspace", "box", ["A workspace's Thread defaults dialog"], "open"),
  e("defaults.reset", "defaults", "Start with", "Use Docket's defaults…", "every", "box", ["Thread defaults › Reset"], "act"),
  e("plans.start", "defaults", "Builds from plans", "Start the build when a plan is done", "every", "box", ["Thread defaults › Plans › Auto-start"]),
  e("plans.archive", "defaults", "Builds from plans", "Archive the plan's thread once the build starts", "every", "box", ["Thread defaults › Plans › Plan archived on start"]),
  e("plans.model", "defaults", "Builds from plans", "Build model", "every", "box", ["Thread defaults › Plans › Build model"]),
  e("plans.effort", "defaults", "Builds from plans", "Build effort", "every", "box", ["Thread defaults › Plans › Build reasoning"]),
  e("plans.context", "defaults", "Builds from plans", "Build context", "every", "box", ["Thread defaults › Plans › Build context"]),

  e("reviews.on", "reviews", "", "Review before merge", "every", "box", ["Reviews › Review before merge"]),
  e("reviews.model", "reviews", "", "Review model", "every", "box", ["Reviews › Reviewer"]),
  e("reviews.effort", "reviews", "", "Effort", "every", "box", ["Reviews › Reasoning"]),
  e("reviews.stop", "reviews", "", "Stop the merge for", "every", "box", ["Reviews › Blocking findings"]),
  e("reviews.wait", "reviews", "", "Wait at most", "every", "box", ["Reviews › Time limit"]),
  e("reviews.different", "reviews", "", "Different in {n} projects", "workspace", "box", ["A project's settings › Reviews"], "open"),

  e("sub.gives", "orchestration", "The lead thread", "Gives its agents", "every", "box", ["Orchestration › Conduct › Delegation"]),
  e("sub.edits", "orchestration", "The lead thread", "May edit files itself", "every", "box", ["Orchestration › Conduct › File edits"]),
  e("sub.commands", "orchestration", "The lead thread", "May run commands itself", "every", "box", ["Orchestration › Conduct › Shell commands"]),
  e("sub.checks", "orchestration", "The lead thread", "Checks its agents' work", "every", "box", ["Orchestration › Conduct › Result checks"]),
  e("sub.retries", "orchestration", "The lead thread", "Retries with a stronger model", "every", "box", ["Orchestration › Conduct › Escalation"]),
  e("sub.checkout", "orchestration", "The lead thread", "Gives each agent its own checkout", "every", "box", ["Orchestration › Conduct › Worktree isolation"]),
  e("sub.atOnce", "orchestration", "Limits", "Agents at once", "every", "box", ["Orchestration › Conduct › Parallel agents"]),
  e("sub.perThread", "orchestration", "Limits", "Agents per thread", "every", "box", ["Orchestration › Conduct › Total per thread"]),
  e("sub.models", "orchestration", "Models", "Models agents may run on", "every", "box", ["Orchestration › Subagent models"], "open"),
  e("sub.routing", "orchestration", "Which model gets which work", "Which model gets which work", "every", "box", ["Orchestration › Routing"], "list"),
  e("sub.addRule", "orchestration", "Which model gets which work", "Add rule…", "every", "box", ["Orchestration › Routing › Add rule"], "act"),
  e("sub.reset", "orchestration", "The lead thread", "Use Docket's defaults…", "every", "box", ["Orchestration › Reset"], "act"),

  e("away.code", "away", "", "Code threads", "every", "host", ["The rail's Away switch", "Threads menu › Away"]),
  e("away.work", "away", "", "Work threads", "every", "host", ["The rail's Away switch", "Threads menu › Away"]),
  e("away.last", "away", "", "Last time away", "every", "none", [], "open"),

  e("addons.list", "addons", "", "Add-ons", "every", "box", ["Add-ons", "MCP servers"], "list"),
  e("skills.list", "skills", "", "Skills", "every", "box", ["Skills"], "list"),

  e("sync.settings", "sync", "", "Agent settings", "every", "host", ["Hosts › Sync › Harness config"]),
  e("sync.memory", "sync", "", "Agents' memory", "every", "host", ["Hosts › Sync › Memory"]),
  e("sync.last", "sync", "Last synced", "Last synced", "every", "none", ["Hosts › a host › Sync now"], "list"),
  e("sync.conflicts", "sync", "", "Conflict copies", "every", "none", ["Hosts › Sync › Conflict copies"], "open"),

  e("accounts.list", "accounts", "", "AI accounts", "every", "host", ["The rail's Accounts page"], "list"),
  e("accounts.connections", "accounts", "", "LifeOS, Office and Google sign-ins", "work", "none", [], "open"),

  // ── Other computers ──────────────────────────────────────────────────
  e("pc.version", "computer:*", "", "Docket {version}", "computer", "none", ["Hosts › a host › Deploy master…"], "act"),
  e("pc.atOnce", "computer:*", "Threads on {computer}", "Threads at once", "computer", "host", ["Hosts › a host › Running threads"]),
  e("pc.stuck", "computer:*", "Threads on {computer}", "Tell me a thread is stuck after", "computer", "host", ["Hosts › Stuck after (that host's own page only)"]),
  e("pc.attachment", "computer:*", "Threads on {computer}", "Largest attachment", "computer", "host", ["Hosts › Attachment limit (that host's own page only)"]),
  e("pc.apps", "computer:*", "Agent apps", "Agent apps", "computer", "none", ["Providers (that host's own page only)"], "list"),
  e("pc.signIns", "computer:*", "Who can sign in to {computer}", "Who can sign in to {computer}", "computer", "host", ["Hosts › Clients (that host's own page only)"], "list"),
  e("pc.add", "computer:*", "Who can sign in to {computer}", "Add…", "computer", "host", ["Hosts › a host › ⋯ › Pair a device…"], "act"),
  e("pc.work", "computer:*", "", "Work", "computer", "none", ["Settings › Work › Work is on for"], "open"),
  e("pc.setup", "computer:*", "Set up from {mac}", "Accounts it was given", "computer", "box", ["Hosts › Computers"]),
  e("pc.reach", "computer:*", "Advanced", "Let other devices reach {computer}", "computer", "host", ["Hosts › Remote access (that host's own page only)"]),
  e("pc.port", "computer:*", "Advanced", "Port", "computer", "host", ["Hosts › Port (that host's own page only)"]),
  e("pc.address", "computer:*", "Advanced", "Web address", "computer", "host", ["Hosts › Public origin (that host's own page only)"]),
  e("pc.id", "computer:*", "Advanced", "Computer ID", "computer", "none", [], "act"),
  e("pc.may", "computer:*", "On {mac}", "What {computer} may do on {mac}", "here", "none", ["Hosts › Mac bridge for a host"], "open"),
  e("pc.name", "computer:*", "On {mac}", "Name", "here", "host", ["Hosts › a host › ⋯ › Rename…"]),
  e("pc.addresses", "computer:*", "On {mac}", "Addresses {mac} tries", "here", "host", ["Hosts › a host › ⋯ › Routes…"], "open"),
  e("pc.forget", "computer:*", "On {mac}", "Forget {computer}", "here", "host", ["Hosts › a host › ⋯ › Remove…"], "act"),

  e("winvm.windows", "winvm", "", "Windows", "computer", "host", ["Work › Windows VM"], "act"),
  e("winvm.sleeps", "winvm", "", "Sleeps after", "computer", "host", ["Work › Windows VM › Sleeps after"]),
  e("winvm.screen", "winvm", "", "Screen size", "computer", "host", ["Work › Windows VM › Live resize", "Work › Windows VM › Screen size"]),
  e("winvm.quality", "winvm", "", "Picture quality", "computer", "host", ["Work › Windows VM › Detail"]),
  e("winvm.restore", "winvm", "", "Restore points", "computer", "host", ["Work › Windows VM › Restore points…"], "open"),

  // ── Work ─────────────────────────────────────────────────────────────
  e("work.on", "work", "Work is on for", "Work is on for", "computer", "host", ["Work › Work"], "list"),
  e("work.access", "work", "Access for each job's new threads", "Access for each job's new threads", "workspace", "box", ["Work › Models"], "list"),
  e("work.grants", "work", "Without asking you", "Things threads may send on their own", "work", "host", ["Outbox › Grants"], "open"),
  e("work.tools", "work", "Without asking you", "What each add-on's tools may do", "work", "host", ["The phone › Work › Add-on tools"], "open"),
  e("work.away", "work", "Without asking you", "While you are away", "every", "none", [], "open"),
  e("work.start", "work", "Travel", "Start addresses", "lifeos", "lifeos", ["Work › Start places"], "open"),
  e("work.home", "work", "On {mac}", "New jobs are made on", "app", "ls", ["Work › Where it runs › New Work workspaces are made on"]),

  e("digest.at", "digest", "The day's digest", "Arrives at", "work", "host", ["Work › Digest › Time"]),
  e("digest.waiting", "digest", "Tell me about", "Things waiting for me", "work", "host", ["Work › Digest › Held items"]),
  e("digest.routines", "digest", "Tell me about", "Routine results", "work", "host", ["Work › Digest › Routine results"]),
  e("digest.messages", "digest", "Tell me about", "Messages and mail", "work", "host", ["Work › Digest › Messages and mail"]),
  e("digest.meetings", "digest", "Tell me about", "Meetings", "work", "host", ["Work › Digest › Meetings"]),

  e("mail.from", "mail", "Writing", "New mail goes from", "lifeos", "lifeos", ["Work › Mail › Writing › New mail goes from"]),
  e("mail.replies", "mail", "Writing", "Replies go to", "lifeos", "lifeos", ["Work › Mail › Writing › Replies go to"]),
  e("mail.undo", "mail", "Writing", "Undo send", "lifeos", "lifeos", ["Work › Mail › Writing › Undo send"]),
  e("mail.pictures", "mail", "Reading", "Pictures from the web", "lifeos", "lifeos", ["Work › Mail › Reading › Pictures from the web"]),
  e("mail.senders", "mail", "Reading", "Pictures always show from", "lifeos", "lifeos", ["Work › Mail › Reading › Always from"], "open"),
  e("mail.density", "mail", "Reading", "List rows", "lifeos", "lifeos", ["Work › Mail › Reading › List rows"]),
  e("mail.markRead", "mail", "Reading", "Mark as read", "lifeos", "lifeos", ["Work › Mail › Reading › Mark as read"]),
  e("mail.signatures", "mail", "Signatures", "Signatures", "lifeos", "lifeos", ["Work › Mail › Signatures"], "list"),
  e("mail.accounts", "mail", "Accounts", "Accounts", "lifeos", "lifeos", ["Work › Mail › Accounts"], "list"),
  e("mail.grants", "mail", "Without asking you", "Things threads may send on their own", "work", "host", [], "open"),

  e("files.folders", "files", "Folders on {computer}", "Folders on {computer}", "computer", "host", ["Work › Folders"], "list"),
  e("files.add", "files", "Folders on {computer}", "Add folder…", "computer", "host", ["Work › Folders › Add folder…"], "act"),
  e("files.vm", "files", "Folders in the Windows VM", "Folders in the Windows VM", "computer", "host", ["Work › Folders"], "list"),
  e("files.guests", "files", "Guests", "Shared with guests", "work", "host", ["Work › Guest links"], "open"),
  e("files.word", "files", "On {mac}", "Word files save to Teams", "app", "ls", ["Work › Word files › Save to Teams"]),

  e("connections.list", "connections", "", "Connections", "computer", "host", ["Connections", "Work › Windows VM › Office", "Work › Windows VM › OneDrive", "Work › Windows VM › Edition"], "list"),

  // ── A job ────────────────────────────────────────────────────────────
  e("job.computers", "job", "Computers its threads may use", "Computers its threads may use", "workspace", "ws", ["A Work workspace › Where it runs › Computer use on a host"], "list"),
  e("job.vm", "job", "Computers its threads may use", "Windows VM", "workspace", "ws", ["A Work workspace › Where it runs › Computer use on the Windows VM"]),
  e("job.copy", "job", "Computers its threads may use", "Copy Teams files to {computer}", "workspace", "host", ["A Work workspace › Where it runs › Copy Teams files"]),
  e("job.threads", "job", "New threads", "Model and access", "workspace", "box", ["A Work workspace › New threads", "The rail's Thread defaults dialog"], "open"),
  e("job.rules", "job", "Rules", "Rules", "workspace", "host", ["A Work workspace › House rules"], "list"),
  e("job.proposed", "job", "Proposed", "Proposed", "workspace", "host", ["A Work workspace › Proposed"], "list"),
  e("job.voice", "job", "Writing and mail", "Learn how I write from my sent mail", "workspace", "ws", ["A Work workspace › Voice › Read my sent mail for how I write"]),
  e("job.unanswered", "job", "Writing and mail", "Count sent mail as unanswered after", "workspace", "lifeos", ["A Work workspace › Waiting on › Count as waiting after"]),
  e("job.nudges", "job", "Writing and mail", "Draft nudges by themselves", "workspace", "host", ["A Work workspace › Waiting on › Draft nudges"]),

  // ── A code workspace ─────────────────────────────────────────────────
  e("ws.threads", "workspace", "New threads", "Model and access", "workspace", "box", ["A workspace › Thread defaults", "The rail's Thread defaults dialog"], "open"),
  e("ws.rules", "workspace", "New threads", "Rules read before the first message", "workspace", "ws", ["The workspace menu › Preamble…"], "open"),
  e("ws.checks", "workspace", "After each turn", "Run the checks", "workspace", "host", ["A workspace › Completed turn › Checks"]),
  e("ws.build", "workspace", "After each turn", "Make a fresh build", "workspace", "host", ["A workspace › Completed turn › Fresh build"]),
  e("ws.commit", "workspace", "After each turn", "Commit", "workspace", "host", ["A workspace › Completed turn › Commit"]),
  e("ws.accounts", "workspace", "Accounts", "Accounts", "workspace", "ws", ["A workspace › Accounts"], "list"),
  e("ws.command", "workspace", "Build", "Command", "workspace", "host", ["A workspace › Build › Command"]),
  e("ws.makes", "workspace", "Build", "What it makes", "workspace", "host", ["A workspace › Build › Outputs"]),
  e("ws.agents", "workspace", "Subagents", "Rules for its agents", "workspace", "box", ["A workspace › Conduct", "A workspace › Subagent models", "A workspace › Routing"], "open"),
  e("ws.job", "workspace", "Its job", "Its job", "workspace", "ws", ["A workspace › LifeOS › Sector"]),
  e("ws.projects", "workspace", "Projects", "Projects", "workspace", "ws", ["A workspace › Projects"], "list"),

  // ── Archive ──────────────────────────────────────────────────────────
  e("archive.projects", "archive", "Projects", "Projects", "every", "host", ["Archive › Projects"], "list"),
  e("archive.threads", "archive", "Threads", "Threads", "every", "host", ["Archive › Threads"], "list"),
];

const BY_ID = new Map(SETTINGS_MAP.map((entry) => [entry.id, entry] as const));

/** A row's entry; a row the map lacks is a mistake in the page, said loudly. */
export function settingEntry(id: string): SettingEntry {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error(`No setting "${id}" in lib/settings/map.ts`);
  return entry;
}

export const hasSetting = (id: string): boolean => BY_ID.has(id);

/** What a name's placeholders stand for in one window, on one row. */
export type SettingVars = { mac?: string; computer?: string; n?: number | string; version?: string };

/** A map name as a window says it: `{mac}` as this window's own word mid-line, `{computer}` as the other computer's
 *  name mid-line, a first letter raised when the name starts with one of them, the word after `{n}` singular for one.
 *  A placeholder with no value stays out. */
export function settingWords(text: string, vars: SettingVars = {}): string {
  // One of a thing is said in the singular: "Different in 1 project".
  const counted = String(vars.n) === "1" ? text.replace(/\{n\} (\w+?)s\b/g, "{n} $1") : text;
  const filled = counted
    .replaceAll("{mac}", vars.mac ?? "this Mac")
    .replaceAll("{computer}", vars.computer ?? "a computer")
    .replaceAll("{n}", vars.n === undefined ? "" : String(vars.n))
    .replaceAll("{version}", vars.version ?? "")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Only a name that starts with a placeholder has its first letter raised: "macOS permissions" stays as written.
  return text.startsWith("{") ? filled.charAt(0).toUpperCase() + filled.slice(1) : filled;
}

/** A row's name as this window says it. */
export const settingTitle = (id: string, vars?: SettingVars): string => settingWords(settingEntry(id).title, vars);

/** A page's entries, in the map's order. */
export const settingsOnPage = (page: SettingPage): SettingEntry[] => SETTINGS_MAP.filter((entry) => entry.page === page);
