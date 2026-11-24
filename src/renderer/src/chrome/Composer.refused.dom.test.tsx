// @vitest-environment jsdom
/**
 * A send nothing took leaves the field as it was. Files → Ask once emptied the composer and made no thread
 * (2026-11-24): the field cleared before anything had the message. `onSubmit` answering false keeps his words
 * and says why; any other answer clears the field as before.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./CwdPicker", () => ({ CwdPicker: () => null }));
vi.mock("./DraftHostPicker", () => ({ DraftHostPicker: () => null }));
vi.mock("./BranchPicker", () => ({ BranchPicker: () => null }));
vi.mock("./ThreadTypeChip", () => ({ ThreadTypeChip: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

import { Composer } from "./Composer";

afterEach(cleanup);

function mount(onSubmit: () => boolean | void) {
  const view = render(
    <Composer
      focused={false}
      harness="claude"
      model="claude-opus-5-5"
      runtimeMode={"supervised" as never}
      executionCwd="/jobs/purdue"
      cwd="/jobs/purdue"
      sessionId="chat-1"
      onFocus={() => {}}
      onCwdChange={() => {}}
      onModelChange={() => {}}
      onRuntimeModeChange={() => {}}
      onSubmit={onSubmit}
    />,
  );
  const field = view.container.querySelector<HTMLElement>("[data-composer-input]")!;
  act(() => {
    field.append(document.createTextNode("what does page 3 say?"));
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = () => fireEvent.keyDown(field, { key: "Enter" });
  return { ...view, field, send };
}

describe("a send nothing took", () => {
  it("keeps his words in the field and says it was not sent", () => {
    const onSubmit = vi.fn(() => false);
    const view = mount(onSubmit);
    view.send();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(view.field.textContent).toBe("what does page 3 say?");
    expect(view.getByRole("alert").textContent).toContain("Not sent");
  });

  it("clears the field once the message is taken", () => {
    const onSubmit = vi.fn(() => undefined);
    const view = mount(onSubmit);
    view.send();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(view.field.textContent).toBe("");
    expect(view.queryByRole("alert")).toBeNull();
  });
});
