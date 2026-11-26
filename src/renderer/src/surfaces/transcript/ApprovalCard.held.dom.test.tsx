// @vitest-environment jsdom
/**
 * transcript-09 (D5): a waiting card's presses go to the thread's host. While its link is not open they are held,
 * the host's state their tooltip; a key that may not answer gets who can. The link is read in the waiting branch
 * alone: a settled row, under every action row, subscribes to nothing.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Capability } from "@shared/capabilities";
import type { Block } from "../../lib/session";
import { registry, type EnvironmentStatus } from "../../lib/connection";
import { IDLE_STATUS } from "../../lib/connection/types";
import { sessionStore } from "../../lib/tcserver/store";
import { TranscriptSessionContext } from "../transcriptSession";
import { ApprovalCard } from "./ApprovalCard";
import { FailureCardView } from "../FailureCard";
import { QuestionCard } from "../../components/ui/question-card";

const block = (decided?: "allow"): Block => ({ id: "a", role: "approval", text: "", tool: { name: "Bash", input: { command: "ls" }, kind: "execute" }, approval: { requestId: 7, decided } });
let status: EnvironmentStatus = { ...IDLE_STATUS, transport: "open" };
const hello = (caps: Capability[]) => ({ environmentId: "env_box", contract: 3, caps, key: { id: "k", name: "A paired laptop" } }) as never;

beforeEach(() => {
  vi.spyOn(sessionStore, "environmentOf").mockReturnValue("env_box");
  vi.spyOn(registry, "environmentsSnapshot").mockReturnValue([{ id: "env_box", name: "The box", routes: [], credentialRef: null }]);
  vi.spyOn(registry, "environment").mockReturnValue({ id: "env_box", name: "The box", routes: [], credentialRef: null });
  vi.spyOn(registry, "statusOf").mockImplementation(() => status);
  vi.spyOn(registry, "statuses").mockImplementation(() => new Map([["env_box", status]]));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const draw = (b: Block) => render(<TranscriptSessionContext.Provider value="s1"><ApprovalCard block={b} onApproval={() => {}} /></TranscriptSessionContext.Provider>);

describe("a waiting approval on a host that is away", () => {
  it("holds Allow and Deny, the host's state on the pair", () => {
    status = { ...IDLE_STATUS, transport: "offline", lastError: "connect ECONNREFUSED" };
    const { container } = draw(block());
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector("[data-held]")).not.toBeNull();
  });

  it("keeps them live while the link is open", () => {
    status = { ...IDLE_STATUS, transport: "open" };
    const { container } = draw(block());
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector("[data-held]")).toBeNull();
  });

  it("gives a key that may not approve who can, in the buttons' place", () => {
    status = { ...IDLE_STATUS, transport: "open", lastHello: hello(["read", "operate"]) };
    draw(block());
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    const line = screen.getByText("Answer from a computer that manages the box");
    // It wraps rather than cuts (council round 4, S F3.1): the host's name comes last; the mark keeps the first line's axis.
    expect(line.className.split(" ")).not.toContain("truncate");
    expect(line.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "py-1", "leading-5"]));
    expect(document.querySelector("[data-approval-mark]")!.className.split(" ")).toEqual(expect.arrayContaining(["h-7", "self-start", "items-center"]));
  });

  it("subscribes to nothing once settled", () => {
    const subscribe = vi.spyOn(registry, "subscribe");
    draw(block("allow"));
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe("the other waiting cards", () => {
  it("a failure holds the actions that go to the host and keeps this computer's own", () => {
    const failure = { kind: "auth", summary: "Signed out", cause: "The account signed out" } as never;
    render(
      <FailureCardView
        failure={failure}
        actions={[{ id: "retry", label: "Retry" }, { id: "open-accounts", label: "Open Accounts" }] as never}
        note={null}
        state={{ pending: null, outcome: null }}
        onAction={() => {}}
        held="The box is offline"
      />,
    );
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Open Accounts" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a question holds Skip and the last Continue, never Next", () => {
    const options = [{ label: "Fast" }, { label: "Small" }];
    const { rerender } = render(<QuestionCard questions={[{ prompt: "Which?", options }, { prompt: "And?", options }]} onSkip={() => {}} held="The box is offline" />);
    expect((screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: /^Next/ }).closest("[data-held]")).toBeNull();
    rerender(<QuestionCard questions={[{ prompt: "Which?", options }]} onSkip={() => {}} held="The box is offline" />);
    expect(screen.getByRole("button", { name: /^Continue/ }).closest("[data-held]")).not.toBeNull();
  });
});
