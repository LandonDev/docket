// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolsReport } from "@shared/contract-work-formats";
import type { Link } from "../../lib/connection/link";
import { ToolchainRow, toolchainLine } from "./ToolchainRow";

afterEach(cleanup);

const tool = (name: string, version: string, ok: boolean, extra: Partial<ToolsReport["tools"][number]> = {}): ToolsReport["tools"][number] => ({
  name,
  pillar: "toolchain",
  version,
  licence: "MIT",
  ok,
  ...extra,
});
const GB = 1024 * 1024 * 1024;
const BOX: ToolsReport["tools"] = [
  tool("ffmpeg", "9.0.2", true, { bytes: 0.17 * GB }),
  tool("ironcalc", "0.9.1", true, { bytes: 0.01 * GB }),
  tool("libreoffice", "26.8.3", true, { bytes: 0.72 * GB }),
  tool("python", "3.12.16", true, { bytes: 0.22 * GB }),
  tool("venv", "3.12.16", true, { bytes: 0.01 * GB }),
];

/** A link whose answers the test hands out by hand. */
function fakeLink() {
  const asks: { resolve: (r: ToolsReport) => void; reject: (e: Error) => void }[] = [];
  const link = {
    connected: true,
    onOpen: () => () => {},
    request: (method: string) => {
      expect(method).toBe("work.formats.tools");
      return new Promise((resolve, reject) => asks.push({ resolve, reject }));
    },
  } as unknown as Link;
  return { link, asks };
}

describe("toolchainLine", () => {
  it("names each tool by its release, leaves the venv out, and adds up what is on disk", () => {
    const line = toolchainLine({ tools: BOX });
    expect(line).toMatchObject({ installed: "ffmpeg 9.0, IronCalc 0.9, LibreOffice 26.8 and Python 3.12", failed: null });
    expect(line.bytes / GB).toBeCloseTo(1.13);
  });

  it("says which tools did not install, but not those this platform is not offered", () => {
    const tools = [tool("python", "3.12.16", true), tool("libreoffice", "26.8.3", false, { error: "not offered on win32-x64" }), tool("ffmpeg", "9.0.2", false, { error: "checksum mismatch" }), tool("python-pptx", "1.0.2", false, { error: "pip install failed" })];
    expect(toolchainLine({ tools })).toEqual({ installed: "Python 3.12", failed: "ffmpeg and python-pptx did not install", bytes: 0 });
    expect(toolchainLine({ tools: [] }).installed).toBe("None installed");
  });
});

describe("ToolchainRow", () => {
  it("holds a row's shape while the host answers, then shows the line and the size", async () => {
    const { link, asks } = fakeLink();
    render(<ToolchainRow link={link} />);
    expect(screen.getByLabelText("Loading")).toBeTruthy();
    await act(async () => asks[0].resolve({ host: "box", platform: "linux-x64", tools: BOX, converts: [], queue: { cap: { jobs: 4, threads: 16 }, running: 0, queued: 0 } }));
    expect(screen.getByText("Conversion tools")).toBeTruthy();
    expect(screen.getByText("ffmpeg 9.0, IronCalc 0.9, LibreOffice 26.8 and Python 3.12")).toBeTruthy();
    expect(screen.getByText("1.1 GB")).toBeTruthy();
    expect(screen.queryByLabelText("Loading")).toBeNull();
  });

  it("shows the host's refusal in the row with Retry, which asks again", async () => {
    const { link, asks } = fakeLink();
    render(<ToolchainRow link={link} />);
    await act(async () => asks[0].reject(new Error("Work is off on this host")));
    expect(screen.getByText("Work is off on this host")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(asks).toHaveLength(2);
    await act(async () => asks[1].resolve({ host: "box", platform: "linux-x64", tools: [], converts: [], queue: { cap: { jobs: 1, threads: 1 }, running: 0, queued: 0 } }));
    expect(screen.getByText("None installed")).toBeTruthy();
  });
});
