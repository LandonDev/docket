// Fixtures for `bun run ui:preview src/renderer/src/surfaces/settings/SettingsPages.preview.tsx#SettingsPagePreview`:
// every Settings page as its host answers it, then the pages that read a host while it is silent and once it refused.
// SETTINGS_PREVIEW=editor,sharing keeps those pages' fixtures alone, so each page's shots stay readable.
const PAGES = [
  "general",
  "winvm",
  "updates",
  "away",
  "defaults",
  "defaults-offline",
  "appearance",
  "appearance-work",
  "editor",
  "keybindings",
  "addons",
  "skills",
  "addons-empty",
  "skills-empty",
  "addons-offline",
  "skills-offline",
  "computer",
  "computer-empty",
  "computer-down",
  "orchestration",
  "orchestration-offline",
  "accounts",
  "reviews",
  "reviews-off",
  "workspace",
  // One dialog or sheet open over its page: shoot each alone.
  "defaults-places",
  "orchestration-models",
  "orchestration-rule",
  "addons-add",
  "addons-edit",
  "skills-edit",
  "workspace-work",
  "project",
  // A Mac's desktop window from here on (AsMac in the preview): keep these last.
  "general-mac",
  "keybindings-work",
  "appshots",
  "here",
  "sharing",
  "sharing-may",
  "computer-box",
  "computer-box-offline",
  "computer-box-key",
  "computer-pc",
  "sync",
  "publish",
  "publish-running",
  "job",
  "archive",
  // Work's pages are a Mac's window too, with three computers.
  "work-off",
  "work",
  "work-given",
  "work-grants",
  "work-tools",
  "work-confirm",
  "digest",
  "digest-given",
  "files",
  "files-guests",
  "mail",
  "connections",
] as const;
const READS = new Set<string>(["here", "sharing", "sync", "publish", "winvm", "computer-box", "general", "updates", "appshots", "defaults", "editor", "addons", "skills", "orchestration", "reviews", "workspace", "computer", "job", "project", "archive", "work", "digest", "files"]);
const only = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SETTINGS_PREVIEW?.split(",");
// A fixture with a dialog open covers the window: it is drawn only when named.
const OPEN = new Set<string>(["defaults-places", "orchestration-models", "orchestration-rule", "addons-add", "addons-edit", "skills-edit"]);
const shown = PAGES.filter((page) => (only ? only.includes(page) : !OPEN.has(page)));

export default shown.flatMap((page) => [
  { name: `${page}: the host answered`, props: { page, host: "answers" } },
  ...(READS.has(page)
    ? [
        { name: `${page}: the host has not answered`, props: { page, host: "silent" } },
        { name: `${page}: the host refused`, props: { page, host: "refuses" } },
      ]
    : []),
]);
