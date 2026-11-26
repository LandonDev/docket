// bun run ui:preview src/renderer/src/components/ui/toaster.preview.tsx#ToastPreview --shot --fresh
// Export ToastPreview. Sonner draws above a thread or in a page corner. Static shots hold the notices without timers or dismissal.
import { useEffect, useState } from "react";
import { ApprovalToasts } from "../../chrome/ApprovalToasts";
import { BatchNoticesToasts } from "../../chrome/ThreadBatchToasts";
import { AllowToasts } from "../../chrome/ComputerAllowToasts";
import { AgentTranscript } from "../../surfaces/AgentTranscript";
import { ChatFooter } from "../../surfaces/threads/chatSlots";
import { COLUMN_MAX_CLASS } from "../../surfaces/transcriptOutlineModel";
import type { Block } from "../../lib/session";
import { Input } from "./input";
import { QuestionCard } from "../../surfaces/QuestionCard";
import { loadToast, Toaster } from "./toaster";

const noop = () => {};
const blocks: Block[] = [
  { id: "ask", role: "user", text: "Check the route notes before we print." },
  { id: "answer", role: "assistant", text: "The map and the bridge notice now agree." },
];
const question = { sessionId: "toast-preview", requestId: "route", questions: [{ header: "Route", question: "Which route should the guide lead with?", options: [{ label: "West trail" }, { label: "River trail" }] }] };

export function ToastPreview({ state = "approval" }: { state?: string }) {
  const [css, setCss] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setCss([...document.head.querySelectorAll("style")].map((element) => element.textContent ?? "").filter((text) => text.includes("data-sonner-toaster")).join("\n")), 35);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    const ids: (string | number)[] = [];
    let mounted = true;
    void loadToast().then((toast) => {
      if (!mounted) return;
      const options = { duration: Infinity, closeButton: true };
      if (state === "failure") ids.push(toast.error("Couldn’t load route notes", { ...options, description: "The box did not answer." }));
      if (state === "loading") ids.push(toast.loading("Reading the route notes…", options));
      if (state === "code-only") ids.push(toast("Copied the code", { ...options, description: <code>guide routes check</code> }));
      if (state === "corner") ids.push(toast.success("Workspace saved", options));
    });
    return () => { mounted = false; void loadToast().then((toast) => ids.forEach((id) => toast.dismiss(id))); };
  }, [state]);
  const corner = state === "corner";
  return (
    <div data-preview-toast-frame className="relative flex h-[420px] min-w-0 flex-col overflow-hidden border border-border bg-background" style={{ transform: "translateZ(0)" }}>
      <style>{css}</style>
      <div className="flex min-h-0 flex-1 flex-col">
        {corner ? <h2 className="px-4 pt-4 text-sm font-medium">Workspaces</h2> : <div className="min-h-0 flex-1"><AgentTranscript blocks={blocks} sessionId="toast-preview" visible /></div>}
        {/* The transcript's last row: a waiting question in this thread while another thread's approval arrives. */}
        {state === "waiting question" ? <div className={`mx-auto w-full ${COLUMN_MAX_CLASS} px-4 pb-2`}><QuestionCard question={question} onAnswer={noop} /></div> : null}
      </div>
      {corner ? null : <ChatFooter slots={{ transcript: null, anchor: "toast-preview", strip: <p className="px-2 py-1 text-xs text-muted-foreground">Working</p>, composer: <Input aria-label="Message" placeholder="Message" /> }} />}
      <Toaster expand={state === "batch"} />
      {state === "batch" ? <BatchNoticesToasts onOpen={noop} notices={[{
        key: 1, action: "pause", succeeded: 3, failed: [
          { sessionId: "bridge", environmentId: "local", title: "Check the bridge", error: "The box did not answer." },
          { sessionId: "proof", environmentId: "local", title: "Proof the print copy", error: "The box did not answer." },
        ],
      }]} /> : null}
      {state === "approval" || state === "host away" || state === "waiting question" ? <ApprovalToasts notices={[{ sessionId: "guide", title: "Check the bridge", requestId: 1, tool: "Bash", label: state === "host away" ? "The box is offline" : "Run the route checks?" }]} onFocusSession={noop} onApproval={noop} /> : null}
      {state === "allow" ? <AllowToasts notices={[{ pairingId: "preview", name: "Field laptop", words: ["map", "river", "birch"] }]} onAnswered={noop} /> : null}
    </div>
  );
}
