// bun run ui:preview src/renderer/src/chrome/RemoteFolderDialog.fixtures.tsx#RemoteFolderPreview --shot --fresh
// Export RemoteFolderPreview. The directory, its failure and a subfolder's failure use local fixture replies; no folder is made.
import { useEffect } from "react";
import { registry } from "../lib/connection/registry";
import { bindServer } from "../lib/native";
import { answerAs, asGivenComputer } from "../work/kit.preview";
import { RemoteFolderDialog } from "./RemoteFolderDialog";
import { clickPreviewButton, ignorePreviewAction as noop, previewPending } from "./previewDialogData";

const root = "/projects";
answerAs((method, params, host) => {
  if (method === "workspace.root") {
    if (host === "loading") return previewPending;
    if (host === "failed") throw new Error("The box did not answer.");
    return { root, home: "/home/guide", hostname: "The box", platform: "linux", exists: true };
  }
  if (method === "fs.listPath") {
    if (host === "subfolder failed" && (params as { path?: string } | undefined)?.path === root + "/Trail maps") throw new Error("The box did not answer.");
    return host === "empty" ? [] : ["Field guide", "Trail maps"].map((name) => ({ name, path: root + "/" + name, isDir: true, ignored: false }));
  }
  return undefined;
});
bindServer({ linkOf: (id) => registry.linkOf(id) });
asGivenComputer({ computers: ["loading", "listed", "empty", "new", "failed", "subfolder failed"].map((id) => ({ id, name: "The box", platform: "linux" })) });

export function RemoteFolderPreview({ state = "listed" }: { state?: string }) {
  useEffect(() => {
    if (state !== "new" && state !== "subfolder failed") return;
    // A subfolder whose listing fails: the last good list stays, Retry beside the error.
    const timer = setTimeout(() => clickPreviewButton(state === "new" ? "New folder" : "Trail maps"), 12);
    return () => clearTimeout(timer);
  }, [state]);
  return <RemoteFolderDialog environmentId={state} onClose={noop} onPick={noop} />;
}

export default ["loading", "listed", "empty", "new", "failed", "subfolder failed"].map((state) => ({ name: state, props: { state } }));
