/**
 * The words Settings 2 retired (docs/agents/settings.md "Names"): each was a builder's word for a thing that now has
 * his. `lib/settings/words.test.ts` refuses any of them in what a Settings file shows.
 */
export const RETIRED_WORDS: readonly { word: RegExp; now: string }[] = [
  { word: /\bhosts?\b/i, now: "computer" },
  { word: /\benvironments?\b/i, now: "computer" },
  { word: /\bPair(ing)? (a device|code|link|again)\b/i, now: "Add…, sign-in link, Sign in again" },
  { word: /\bClients\b/, now: "Who can sign in to <computer>" },
  { word: /\bOperate\b/, now: "Run threads" },
  { word: /\bRemote access\b/i, now: "Let other devices reach <computer>" },
  { word: /\bPublic origin\b/i, now: "Web address" },
  { word: /^Stuck after\b/, now: "Tell me a thread is stuck after" },
  { word: /\bRunning threads\b/, now: "Threads at once" },
  { word: /\bAttachment limit\b/i, now: "Largest attachment" },
  { word: /\bRoutes\b/, now: "Addresses this Mac tries" },
  { word: /\bMac bridge\b/i, now: "<computer> on this Mac" },
  { word: /\bDev server forwarding\b/i, now: "Its dev sites open here" },
  { word: /\bShared folders\b/i, now: "Folders it reads without asking" },
  { word: /\bRemembered approvals\b/i, now: "Allowed until Docket quits" },
  { word: /\bLoad limit\b/i, now: "Pause other computers' commands above load" },
  { word: /\bHarness config\b/i, now: "Agent settings" },
  { word: /\bDeploy master\b/i, now: "Update…" },
  { word: /\bMac release\b/i, now: "New release" },
  { word: /\bRelease checkout\b/i, now: "Release folder" },
  { word: /\bCode updates\b/i, now: "Quick updates from" },
  { word: /\bProviders?\b/, now: "Agent app" },
  { word: /\bThread defaults\b/i, now: "New threads" },
  { word: /\bReasoning\b/, now: "Effort" },
  { word: /\bPermission mode\b/i, now: "Access" },
  { word: /\bAuto-start\b/i, now: "Start the build when a plan is done" },
  { word: /\bOrchestration\b/, now: "Subagents" },
  { word: /\bConduct\b/, now: "The lead thread" },
  { word: /\bDelegation\b/, now: "Gives its agents" },
  { word: /\bEscalation\b/, now: "Retries with a stronger model" },
  { word: /\bWorktree isolation\b/i, now: "Gives each agent its own checkout" },
  { word: /\bParallel agents\b/i, now: "Agents at once" },
  { word: /\bSubagent models\b/i, now: "Models agents may run on" },
  { word: /\bReviewer\b/, now: "Review model" },
  { word: /\bBlocking findings\b/i, now: "Stop the merge for" },
  { word: /\bMCP servers?\b/i, now: "Add-on" },
  { word: /\bToken variable\b/i, now: "Name for the sign-in token" },
  { word: /\bCLIs?\b/, now: "Agent apps" },
  { word: /\bPreamble\b/i, now: "Rules read before the first message" },
  { word: /\bCompleted turn\b/i, now: "After each turn" },
  { word: /\bFresh build\b/, now: "Make a fresh build" },
  { word: /\bGhost text\b/i, now: "Inline suggestions" },
  { word: /\bAuto save\b/i, now: "Save as I type" },
  { word: /\bKeybindings\b/, now: "Shortcuts" },
  { word: /\bHeld items\b/i, now: "Things waiting for me" },
  { word: /\bSectors?\b/, now: "the job's name" },
  { word: /\bLive resize\b/i, now: "Screen size" },
  { word: /\bStart places\b/i, now: "Start addresses" },
];

/**
 * The Settings files whose words are held to the glossary, repo-relative under src/renderer/src. A file joins as its
 * page is rebuilt; at the end of Settings 2 it is every file SETTINGS owns.
 */
export const WORDED_FILES: readonly string[] = [
  "lib/settings/map.ts",
  "surfaces/settings/parts/SettingRow.tsx",
  "surfaces/settings/parts/SaveMark.tsx",
  "surfaces/settings/parts/ManagedLine.tsx",
  "surfaces/settings/parts/Fold.tsx",
  "surfaces/settings/parts/ListFilter.tsx",
  "surfaces/settings/parts/Permissions.tsx",
  "surfaces/settings/parts/ComputerName.tsx",
  "surfaces/settings/parts/SwitchListDialog.tsx",
  "surfaces/settings/General.tsx",
  "surfaces/settings/PickerSettings.tsx",
  "surfaces/settings/Updates.tsx",
  "surfaces/settings/Appearance.tsx",
  "surfaces/settings/Editor.tsx",
  "surfaces/settings/Keybindings.tsx",
  "surfaces/settings/Computer.tsx",
  "surfaces/AppshotsSettings.tsx",
  "work/capture/CaptureKeyRow.tsx",
  "lib/settings.ts",
  "surfaces/settings/parts/CopyButton.tsx",
  "surfaces/settings/computers/AddComputer.tsx",
  "surfaces/settings/computers/AddComputerHost.tsx",
  "surfaces/settings/computers/addWords.ts",
  "surfaces/settings/computers/device.tsx",
  "surfaces/settings/computers/frame.tsx",
  "surfaces/settings/computers/link.tsx",
  "surfaces/settings/computers/setup.tsx",
  "surfaces/settings/hosts/dialogs/PairDialog.tsx",
  "surfaces/settings/hosts/dialogs/NewKeyDialog.tsx",
  "surfaces/settings/hosts/dialogs/AddHostDialog.tsx",
  "surfaces/settings/hosts/dialogs/SetupComputerDialog.tsx",
  "surfaces/settings/computers/words.ts",
  "surfaces/settings/computers/read.tsx",
  "surfaces/settings/computers/ThreadsRows.tsx",
  "surfaces/settings/computers/AgentApps.tsx",
  "surfaces/settings/computers/SignIns.tsx",
  "surfaces/settings/computers/Advanced.tsx",
  "surfaces/settings/computers/ThreadsPage.tsx",
  "surfaces/settings/computers/SharingPage.tsx",
  "surfaces/settings/computers/MaySheet.tsx",
  "surfaces/settings/computers/Devices.tsx",
  "surfaces/settings/computers/ComputerPage.tsx",
  "surfaces/settings/computers/SetUpHere.tsx",
  "surfaces/settings/computers/SyncPage.tsx",
  "surfaces/settings/computers/PublishPage.tsx",
  "surfaces/settings/computers/JobLog.tsx",
  "surfaces/settings/computers/Winvm.tsx",
  "surfaces/settings/hosts/computersText.ts",
  "surfaces/settings/hosts/dialogs/RoutesDialog.tsx",
  "surfaces/settings/hosts/dialogs/PublishDialog.tsx",
  "lib/settings/maySheet.ts",
  // Everywhere (S4).
  "surfaces/settings/parts/HomeLine.tsx",
  "surfaces/settings/parts/useDraft.ts",
  "lib/settings/access.ts",
  "lib/settings/pageHome.ts",
  "surfaces/settings/ThreadDefaults.tsx",
  "chrome/ThreadDefaultsDialog.tsx",
  "chrome/PlanSettingsFields.tsx",
  "surfaces/ReviewSettings.tsx",
  "chrome/ReviewFields.tsx",
  "surfaces/settings/Orchestration.tsx",
  "chrome/OrchestrationRules.tsx",
  "surfaces/settings/Away.tsx",
  "surfaces/settings/AccountsFoot.tsx",
  "surfaces/settings/parts/searchNames.ts",
  "surfaces/settings/addons/AddonsPage.tsx",
  "surfaces/settings/addons/AddonRow.tsx",
  "surfaces/settings/addons/AddonDialog.tsx",
  "surfaces/settings/addons/AddonKeyDialog.tsx",
  "surfaces/settings/addons/addonWords.ts",
  "surfaces/settings/addons/useAddons.ts",
  "surfaces/settings/skills/SkillsPage.tsx",
  "surfaces/settings/skills/SkillRow.tsx",
  "surfaces/settings/skills/SkillDialog.tsx",
  "surfaces/settings/skills/skillForm.ts",
  "surfaces/settings/skills/useSkills.ts",
  "lib/settings/jobComputers.ts",
  "lib/settings/workWords.ts",
  "surfaces/settings/parts/StartSetRow.tsx",
  "work/shell/JobSettings.tsx",
  "work/office/TeamsCopyRow.tsx",
  "work/rules/HouseRules.tsx",
  "work/mail/WaitingSection.tsx",
  "surfaces/settings/Workspace.tsx",
  "chrome/TurnPassFields.tsx",
  "chrome/rail/buildSettings.tsx",
  "surfaces/settings/Archive.tsx",
  "lib/settings/access.ts",
  "surfaces/settings/Work.tsx",
  "work/shell/WorkPage.tsx",
  "work/shell/WorkPageSends.tsx",
  "work/clashes/StartPlaces.tsx",
  "work/digest/SettingsSection.tsx",
  "work/shell/WorkPageFiles.tsx",
  "work/office/TeamsFilesRow.tsx",
  "work/guests/GuestLinksSection.tsx",
  "work/mail/MailSettingsSection.tsx",
  "work/connections/ConnectionsPage.tsx",
  "work/connections/model.ts",
  "work/connections/FirstCheckBones.tsx",
  "work/office/AddinRow.tsx",
];

/**
 * What a source file shows: its JSX text and its string literals that read as words (a capital first, or a space in
 * them), with comments, imports, class strings and the map's `was` lists (old names, kept on purpose) left out.
 */
export function shownWords(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
    .replace(/^\s*import[^;]*;/gm, "")
    .replace(/\[\s*(?:"[^"\n]*"\s*,?\s*)*\]\s*(?:,\s*"(?:open|act|fact|list)"\s*)?\)/g, ")")
    .replace(/className=(?:"[^"]*"|\{[^}]*\})/g, "")
    .replace(/\b(?:word|test|match|replace)\b[^\n]*\/[^\n]*/g, "");
  const out: string[] = [];
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    // A template's `${…}` is code, not words: its variable names (`host`) are never shown.
    const text = (m[1] ?? m[2] ?? (m[3] ?? "").replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "…")) ?? "";
    if (/^[A-Z]/.test(text) || /\s/.test(text)) out.push(text);
  }
  // Text between a tag's `>` and the next `<`; a stretch of code between an arrow and a generic (`=> host.request<T>`) is not.
  for (const m of code.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) if (!/[=;]|\b\w+\.\w+(?:\(|$)/.test(m[1].trim())) out.push(m[1].trim());
  return out;
}
