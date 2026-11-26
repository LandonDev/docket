// @vitest-environment jsdom
/**
 * The orchestration thread (A18) is the chat under a header: no board, no
 * agent rows, no "Orchestrator log" edge tab. A spawn row in the transcript
 * still opens the agent's detail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useContext } from "react";
import type { Session } from "../../lib/session";
import type { SessionMeta } from "../../lib/tcserver/types";

const h = vi.hoisted(() => ({ agents: [] as SessionMeta[], opened: [] as string[] }));

vi.mock("../../lib/threads/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/threads/agents")>()),
  useAgents: () => h.agents,
}));
vi.mock("./fleet/AgentDetail", () => ({
  AgentDetail: ({ agentId }: { agentId: string }) => <div data-testid="agent-detail">{agentId}</div>,
}));

import { OpenAgentDetailContext } from "../agentDetailContext";
import { OrchestrationView, orchestrationGoal } from "./OrchestrationView";
import { messageListFold } from "../../lib/messageListFold";
import type { ThreadViewProps } from "./ThreadView";
import { FLEET_METAS } from "./fleet/fleetFixture";

let openAgent: ((id: string) => void) | null = null;
function SpawnRow() {
  openAgent = useContext(OpenAgentDetailContext);
  return <div data-testid="transcript">transcript</div>;
}

const session = {
  id: "orch",
  cwd: "/repo",
  environmentId: "local",
  blocks: [{ id: "u1", role: "user", text: "Ship the iOS thread screens\nin parallel" }],
} as unknown as Session;

const props = (): ThreadViewProps =>
  ({
    session,
    composing: false,
    onArmNewPass: () => {},
    onOpenFile: () => {},
    onOpenDiff: () => {},
    renderChat: () => <SpawnRow />,
    renderSlots: () => ({ transcript: <SpawnRow />, strip: null, composer: <div data-testid="composer" /> }),
  }) as unknown as ThreadViewProps;

afterEach(() => {
  cleanup();
  h.agents = [];
  openAgent = null;
});

describe("OrchestrationView", () => {
  it("is the chat under the header, with no rows and no orchestrator log", () => {
    h.agents = FLEET_METAS;
    const { container, getByTestId, queryByText } = render(<OrchestrationView {...props()} />);
    const header = container.querySelector('[data-slot="fleet-header"]')!;
    expect(header.textContent).toContain("Ship the iOS thread screens");
    expect(header.compareDocumentPosition(getByTestId("transcript")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getByTestId("composer")).toBeTruthy();
    expect(queryByText("Orchestrator log")).toBeNull();
    expect(container.querySelector('[aria-label="Show orchestrator log"]')).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
    // the slot is flex-1 in a column; a block wrapper would leave it unbounded and unscrollable
    expect(getByTestId("transcript").parentElement?.className).toContain("flex-col");
  });

  it("has no header before the first agent", () => {
    const { container, getByTestId } = render(<OrchestrationView {...props()} />);
    expect(container.querySelector('[data-slot="fleet-header"]')).toBeNull();
    expect(getByTestId("transcript")).toBeTruthy();
  });

  it("a spawn row opens the agent's detail", () => {
    h.agents = FLEET_METAS;
    const { getByTestId } = render(<OrchestrationView {...props()} />);
    act(() => openAgent?.("ios-orch-a2"));
    expect(getByTestId("agent-detail").textContent).toBe("ios-orch-a2");
  });

  it("sits on the transcript's column: its gutter, and after the message list while it is beside and open", () => {
    h.agents = FLEET_METAS;
    const at = (placement: "beside" | "hidden" | "above") => {
      const p = props();
      const view = render(<OrchestrationView {...p} renderSlots={() => ({ transcript: <SpawnRow />, strip: null, composer: <div data-testid="composer" />, placement })} />);
      const band = view.container.querySelector<HTMLElement>("[data-fleet-band]")!;
      const footer = view.container.querySelector<HTMLElement>("[data-chat-footer]")!;
      const got = { band: band.className, inner: band.firstElementChild!.className, pad: band.style.paddingLeft, footerInner: footer.firstElementChild!.className, footerPad: footer.style.paddingLeft };
      view.unmount();
      return got;
    };
    messageListFold.set(false);
    const beside = at("beside");
    expect(beside.band).toContain("pe-[calc(1rem+var(--scrollbar-size))]");
    expect(beside.inner).toContain("mr-auto");
    expect(beside.pad).not.toBe("");
    // The composer's band and the header's are one rule.
    expect(beside.inner).toBe(beside.footerInner);
    expect(beside.pad).toBe(beside.footerPad);
    messageListFold.set(true);
    expect(at("beside").inner).toContain("mx-auto");
    messageListFold.set(false);
    expect(at("hidden").inner).toContain("mx-auto");
    expect(at("hidden").pad).toBe("");
  });
});

describe("the orchestration header's goal", () => {
  const user = (id: string, text: string) => ({ id, role: "user", text }) as Session["blocks"][number];
  it("draws no goal while it is the newest bubble's whole text, right under it", () => {
    expect(orchestrationGoal([user("u1", "Ship the iOS thread screens\nin parallel"), user("u2", "yes, go on")])).toBe("");
    expect(orchestrationGoal([user("u1", "Ship the iOS thread screens")])).toBe("");
  });

  it("names the newest brief by its first line when the bubble says more", () => {
    expect(orchestrationGoal([user("u1", "yes"), user("u2", "Ship the iOS thread screens\nin parallel")])).toBe("Ship the iOS thread screens");
    expect(orchestrationGoal([])).toBe("");
  });

  it("the header keeps its sentence with no goal", () => {
    h.agents = FLEET_METAS;
    const p = props();
    const { container } = render(<OrchestrationView {...p} session={{ ...session, blocks: [user("u1", "Ship it"), user("u2", "yes, go on")] } as Session} />);
    const header = container.querySelector('[data-slot="fleet-header"]')!;
    expect(header.textContent).not.toContain("yes, go on");
    expect(header.querySelectorAll("p")).toHaveLength(1);
  });
});
