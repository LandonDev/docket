// @vitest-environment jsdom
/**
 * The keeper of the keys (keptKeys.tsx) at its two edges: keys he dropped himself stay dropped when the content around
 * them changes, and a keeper that leaves the page with the control inside it hands the keys to the keeper around it.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KeptKeys, useKeptKeys } from "./keptKeys";

afterEach(cleanup);

function Pane({ rows, chip }: { rows: number; chip: boolean }) {
  // As the conversation's pane: the log takes the keys when the control that held them goes.
  const pane = useKeptKeys<HTMLDivElement>((el) => el.querySelector<HTMLElement>("[role=log]"));
  return (
    <div ref={pane} tabIndex={-1}>
      <input aria-label="Search" onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()} />
      <div role="log" tabIndex={0}>
        {Array.from({ length: rows }, (_, i) => (
          <p key={i}>row {i}</p>
        ))}
        {chip ? (
          <KeptKeys>
            <button type="button">View spec.pdf</button>
          </KeptKeys>
        ) : null}
      </div>
    </div>
  );
}
const flush = () => act(async () => {});

describe("the keeper", () => {
  it("leaves keys he dropped on the page when a row comes", async () => {
    const view = render(<Pane rows={1} chip={false} />);
    const search = view.getByRole("textbox", { name: "Search" });
    search.focus();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(document.activeElement).toBe(document.body);
    view.rerender(<Pane rows={2} chip={false} />);
    await flush();
    expect(document.activeElement).toBe(document.body);
  });

  it("hands the keys to the keeper around one that left the page with the control inside", async () => {
    const view = render(<Pane rows={1} chip />);
    view.getByRole("button", { name: "View spec.pdf" }).focus();
    view.rerender(<Pane rows={1} chip={false} />);
    await flush();
    expect(document.activeElement).toBe(view.getByRole("log"));
  });

  it("still hands them on when the control that held them is swapped inside a keeper", async () => {
    const view = render(<Pane rows={1} chip />);
    view.getByRole("button", { name: "View spec.pdf" }).focus();
    view.rerender(<Pane rows={2} chip />);
    await flush();
    expect(document.activeElement).toBe(view.getByRole("button", { name: "View spec.pdf" }));
  });
});
