// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { headAsk } from "./headAsk";

/** A header's press its view answers (New routine, New play): the header draws before the body has loaded. */
function pair() {
  const port = headAsk();
  const opened = vi.fn();
  const Head = () => {
    port.useHead();
    return <button onClick={port.ask}>New</button>;
  };
  const Body = () => {
    port.useAnswer(opened);
    return <p>body</p>;
  };
  return { Head, Body, opened };
}

afterEach(cleanup);

describe("a header's press the view answers", () => {
  it("opens once when the body is there", () => {
    const { Head, Body, opened } = pair();
    render(<><Head /><Body /></>);
    expect(opened).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("keeps a press made before the body mounted, and answers it when the body comes", () => {
    const { Head, Body, opened } = pair();
    const page = render(<Head />);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(opened).not.toHaveBeenCalled();
    act(() => page.rerender(<><Head /><Body /></>));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("drops a press no body answered once the header has gone: a later visit opens nothing", () => {
    const { Head, Body, opened } = pair();
    const first = render(<Head />);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    first.unmount();
    render(<><Head /><Body /></>);
    expect(opened).not.toHaveBeenCalled();
  });

  it("a body that mounts again does not answer an old press twice", () => {
    const { Head, Body, opened } = pair();
    const page = render(<><Head /><Body /></>);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    act(() => page.rerender(<Head />));
    act(() => page.rerender(<><Head /><Body /></>));
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
