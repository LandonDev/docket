// @vitest-environment jsdom
/**
 * `useWorkCommands`: how a kind's Body answers File → Print…, Export… and
 * the editor's find (docs/agents/work-editors.md "Who hears a key").
 */
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { editorAnswers, workCommands, type WorkCommandId } from "../../lib/appCommands";
import { useWorkCommands, type WorkCommandHandlers } from "./command";

afterEach(cleanup);

function Editor({ name, handlers }: { name: string; handlers: WorkCommandHandlers }) {
  const root = useRef<HTMLDivElement | null>(null);
  useWorkCommands(root, handlers);
  return (
    <div ref={root} data-editor-keys="document">
      <button data-testid={name}>{name}</button>
    </div>
  );
}

const run = (id: WorkCommandId): boolean => {
  let ran = false;
  act(() => void (ran = workCommands.run(id)));
  return ran;
};

describe("a Body's commands", () => {
  it("offers what it answers while it is mounted, and nothing after", () => {
    const heard: string[] = [];
    expect(workCommands.has("export")).toBe(false);
    const view = render(<Editor name="a" handlers={{ export: () => heard.push("export") }} />);
    expect(workCommands.has("export")).toBe(true);
    expect(workCommands.has("print")).toBe(false);
    // Said on the root, where the key resolver reads it for the editor holding the caret.
    const root = view.getByTestId("a").parentElement!;
    expect(root.getAttribute("data-editor-answers")).toBe("export");
    expect(editorAnswers(view.getByTestId("a"), "export")).toBe(true);
    expect(editorAnswers(view.getByTestId("a"), "print")).toBe(false);
    view.rerender(<Editor name="a" handlers={{ export: () => heard.push("export"), print: () => {}, find: () => {} }} />);
    expect(root.getAttribute("data-editor-answers")).toBe("export find print");
    view.rerender(<Editor name="a" handlers={{ export: () => heard.push("export") }} />);
    expect(root.getAttribute("data-editor-answers")).toBe("export");
    expect(run("export")).toBe(true);
    expect(run("print")).toBe(false);
    expect(heard).toEqual(["export"]);
    view.unmount();
    expect(workCommands.has("export")).toBe(false);
    expect(run("export")).toBe(false);
    expect(heard).toEqual(["export"]);
  });

  it("runs the newest handler without offering again on every render", () => {
    const heard: string[] = [];
    let changes = 0;
    const off = workCommands.subscribe(() => changes++);
    const view = render(<Editor name="a" handlers={{ print: () => heard.push("first") }} />);
    const offered = changes;
    view.rerender(<Editor name="a" handlers={{ print: () => heard.push("second") }} />);
    expect(changes).toBe(offered);
    run("print");
    expect(heard).toEqual(["second"]);
    // What it answers changes: the offer follows.
    view.rerender(<Editor name="a" handlers={{ export: () => heard.push("export") }} />);
    expect(workCommands.has("print")).toBe(false);
    expect(workCommands.has("export")).toBe(true);
    off();
  });

  it("with two editors on screen, goes to the one holding the caret, else the one that held it last, else the newest", () => {
    const heard: string[] = [];
    const view = render(
      <>
        <Editor name="left" handlers={{ print: () => heard.push("left") }} />
        <Editor name="right" handlers={{ print: () => heard.push("right") }} />
        <button data-testid="outside">outside</button>
      </>,
    );
    run("print");
    expect(heard).toEqual(["right"]);
    act(() => view.getByTestId("left").focus());
    run("print");
    expect(heard).toEqual(["right", "left"]);
    // The caret leaves for the rail: the menu's Print… still means the document he was in.
    act(() => view.getByTestId("outside").focus());
    run("print");
    expect(heard).toEqual(["right", "left", "left"]);
    act(() => view.getByTestId("right").focus());
    run("print");
    expect(heard.at(-1)).toBe("right");
  });

  it("an editor that does not answer a command is passed over for one that does", () => {
    const heard: string[] = [];
    const view = render(
      <>
        <Editor name="doc" handlers={{ print: () => heard.push("doc") }} />
        <Editor name="sheet" handlers={{ export: () => heard.push("sheet") }} />
      </>,
    );
    act(() => view.getByTestId("sheet").focus());
    run("print");
    run("export");
    expect(heard).toEqual(["doc", "sheet"]);
  });
});
