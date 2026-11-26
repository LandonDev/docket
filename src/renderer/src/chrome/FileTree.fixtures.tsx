// bun run ui:preview src/renderer/src/chrome/FileTree.fixtures.tsx#FilesPreview --shot --fresh
// Export FilesPreview. The directory answers come from memory. The name fields mount
// in their open state through the real controls. Keyboard traversal needs a live page.
import { useEffect, useRef } from "react";
import { FileTree } from "./FileTree";
import { saveExpanded, saveSelected } from "../lib/fileTree";
import { bindServer } from "../lib/native";

const noop = () => {};
const pending = new Promise<never>(() => {});
const entry = (path: string, isDir = false) => ({ name: path.slice(path.lastIndexOf("/") + 1), path, isDir, ignored: false });

bindServer({
  linkOf: () => ({
    connected: true,
    onOpen: () => noop,
    async request<T>(method: string, params?: unknown): Promise<T> {
      const path = (params as { path?: string } | undefined)?.path ?? "";
      if (method !== "fs.listPath") return undefined as T;
      if (path.endsWith("/loading")) return pending;
      if (path.endsWith("/failed")) throw new Error("The folder could not be listed.");
      if (path.endsWith("/src")) return [entry(path + "/routes.ts")] as T;
      if (path.endsWith("/drafts")) return [] as T;
      return [entry(path + "/src", true), entry(path + "/drafts", true), entry(path + "/README.md")] as T;
    },
  }),
});

function Tree({ state = "tree" }: { state?: "tree" | "loading" | "failed" | "create" | "rename" }) {
  const cwd = "/guide/" + state;
  const frame = useRef<HTMLDivElement>(null);
  saveExpanded(cwd, new Set([cwd, cwd + "/src", cwd + "/drafts"]));
  if (state === "rename") saveSelected(cwd, cwd + "/README.md");
  useEffect(() => {
    if (state === "create") frame.current?.querySelector<HTMLButtonElement>('[aria-label="New file"]')?.click();
    if (state === "rename") {
      const tree = frame.current?.querySelector('[role="tree"]');
      tree?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
      const timer = setTimeout(() => {
        const input = frame.current?.querySelector("input");
        if (!input) return;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "/guide.md");
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      }, 20);
      return () => clearTimeout(timer);
    }
  }, [state]);
  return <div ref={frame} className="min-h-0 flex-1"><FileTree cwd={cwd} onOpenFile={noop} /></div>;
}

export function FilesPreview({ state }: { state?: "tree" | "loading" | "failed" | "create" | "rename" } = {}) {
  return <Tree state={state} />;
}

export default [
  { name: "Expanded folders, including an empty folder", props: { state: "tree" } },
  { name: "First read", props: { state: "loading" } },
  { name: "Failed read", props: { state: "failed" } },
  { name: "New file name", props: { state: "create" } },
  { name: "Rename issue", props: { state: "rename" } },
];
