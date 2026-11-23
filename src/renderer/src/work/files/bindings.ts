import { keyCaps } from "../../lib/keys";
import { addKeybindingGroup } from "../../lib/settings";

/**
 * The Files place's keys, as Settings → Keybindings lists them and `shortcutFor("Files (Work)", …)` reads them.
 * While focus is inside the Files view the tab chords are its own (lib/filesKeys.ts, chords.ts); the tree beside
 * the editor is the app's "Files" group. The table rides the Files view's chunk and the settings chunk, never the
 * first paint: importing this file lists the group.
 */
const [CMD, SHF, CTL, DEL, RET] = keyCaps("mod+shift+ctrl+delete+enter");

addKeybindingGroup({
  title: "Files (Work)",
  work: true,
  bindings: [
    { name: "New Tab", keys: [[CMD, "T"]] },
    { name: "Close Tab", keys: [[CMD, "W"]] },
    { name: "Reopen Closed Tab", keys: [[CMD, SHF, "T"]] },
    { name: "Next Tab", keys: [[CTL, "Tab"], [CMD, SHF, "]"]] },
    { name: "Previous Tab", keys: [[CTL, SHF, "Tab"], [CMD, SHF, "["]] },
    { name: "Back", keys: [[CMD, "["]] },
    { name: "Forward", keys: [[CMD, "]"]] },
    { name: "Go to", keys: [[CMD, "P"]] },
    { name: "Search", keys: [[CMD, "F"], ["/"]] },
    { name: "Open", keys: [[RET]] },
    { name: "Quick Look", keys: [["Space"]] },
    { name: "Parent Folder", keys: [[CMD, "↑"]] },
    { name: "Rename", keys: [["F2"]] },
    { name: "Delete", keys: [[DEL]] },
    { name: "Select All", keys: [[CMD, "A"]] },
    { name: "Leave Full Window", keys: [["Esc"]] },
  ],
});
