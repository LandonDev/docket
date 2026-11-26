// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDetailHeader } from "./AgentDetailHeader";
import { FLEET } from "./fleetFixture";

afterEach(cleanup);

describe("AgentDetailHeader", () => {
  it("a working agent says Working on a still dot, its phase left to the transcript's working line", () => {
    const { container } = render(
      <AgentDetailHeader meta={FLEET[0].meta} status={{ state: "working", detail: "Thinking", phrase: true }} parts={[]} />,
    );
    const mark = container.querySelector<HTMLElement>('[data-slot="status-mark"]')!;
    expect(mark.dataset.state).toBe("working");
    expect(mark.textContent).toBe("Working");
    expect(container.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(container.querySelector('[data-slot="working-dot"]')).not.toBeNull();
  });
  it("any other state keeps its word and what it is about", () => {
    const { container } = render(
      <AgentDetailHeader meta={FLEET[0].meta} status={{ state: "waiting", detail: "Approve Bash", phrase: false }} parts={[]} />,
    );
    expect(container.querySelector('[data-slot="status-mark"]')!.textContent).toBe("Needs youApprove Bash");
  });
});
