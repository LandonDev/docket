export default [
  { name: "read-only preview with action", props: { note: { text: "This Mac's copy is different, on branch main", action: { label: "Open the Mac copy anyway", editor: { path: "/x", line: 1 } } }, readOnly: true } },
  { name: "read-only, no action", props: { note: { text: "No copy on this Mac, on branch main" }, readOnly: true } },
  { name: "launcher failed (writable)", props: { note: { text: "Couldn't open it in IntelliJ IDEA. Opened here instead." } } },
  {
    name: "a long note with its action",
    props: { note: { text: "This Mac's copy is different, on branch feature/raids-and-sieges", action: { label: "Open the Mac copy anyway", editor: { path: "/x", line: 1 } } }, readOnly: true },
  },
];
