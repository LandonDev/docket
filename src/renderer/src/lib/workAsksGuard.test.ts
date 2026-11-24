import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ClientRequestSchema, type ClientRequest } from "@shared/contract";
import { capabilityRefusal, requiredCapability } from "@shared/capabilities";
import { ASK_CALLERS, ASK_PARAMS, ASKS_WITHOUT_FIXTURE, BOX_HOST, BOX_PATH, WORK_ASKS, WORK_PRELOAD } from "@shared/work/asks";
import { attachmentPaths, fencedPaths, FenceError, fenceRequest, workSources } from "../../../main/server/remote/fence";
import { askSources } from "./workAskSources.test-support";
import { sourceFile } from "./guardSource.test-support";

const PLACES = ["box", "far", "vm"] as const;
type Place = (typeof PLACES)[number];

function inventory(found: Map<string, Set<string>>, listed: readonly string[]): string[] {
  const names = new Set(listed);
  return [
    ...[...found].flatMap(([name, sites]) => names.has(name) ? [] : [...sites].map((site) => `${site}: classify ${name}`)),
    ...listed.filter((name) => !found.has(name)).map((name) => `Unused classification: ${name}`),
  ];
}

function request(method: ClientRequest["method"], params: unknown): ClientRequest {
  const parsed = ClientRequestSchema.safeParse({ id: "work-asks-guard", method, params });
  if (!parsed.success) throw new Error(`${method}: ${parsed.error.message}`);
  return parsed.data;
}

function pathParams(method: ClientRequest["method"], root: string, place: Place): unknown {
  const box = join(root, "item.txt");
  const path = place === "box" ? box : place === "far" ? join(dirname(root), "far", "item.txt") : "C:\\Work\\item.txt";
  const params = JSON.parse(JSON.stringify(ASK_PARAMS[method])
    .replaceAll(JSON.stringify(BOX_PATH), JSON.stringify(path))
    .replaceAll(JSON.stringify(BOX_HOST), JSON.stringify(place === "far" ? "env_bbbbbbbbbbbbbbbbbbbbbb" : BOX_HOST)));
  // The same box thread in each case. Only its first chip moves.
  if (method === "session.create") params.cwd = root;
  return params;
}

function fenceVerdict(req: ClientRequest, root: string): "ok" | "refused" {
  try {
    fenceRequest(req, [root], [], [], BOX_HOST);
    return "ok";
  } catch (error) {
    if (error instanceof FenceError) return "refused";
    throw error;
  }
}

describe("Work asks", () => {
  it("classifies each wire and preload ask once", () => {
    const { methods, preload } = askSources();
    const listed = WORK_ASKS.map(([method]) => method);
    expect(listed).toEqual([...new Set(listed)].sort());
    expect(inventory(methods, [...listed, ...Object.keys(ASKS_WITHOUT_FIXTURE)])).toEqual([]);
    expect(inventory(preload, Object.keys(WORK_PRELOAD))).toEqual([]);
    expect(Object.keys(ASK_PARAMS).filter((method) => !listed.includes(method as ClientRequest["method"]))).toEqual([]);
    for (const [method, reason] of Object.entries(ASKS_WITHOUT_FIXTURE)) {
      expect(ClientRequestSchema.options.some(({ shape }) => shape.method.value === method), `${method}: ${reason}`).toBe(false);
    }
  });

  it("keeps the capability and fence verdicts the host gives", () => {
    // The guest column is the Linux box's answer. A Windows listener fences its own drive paths.
    const temp = mkdtempSync(join(tmpdir(), "work-asks-"));
    const root = join(temp, "box");
    try {
      mkdirSync(root);
      const changes: string[] = [];
      const gates = new Set<string>();
      for (const [method, needs, owner, laptop, reader, ui, paths] of WORK_ASKS) {
        const req = request(method, ASK_PARAMS[method]);
        const actualNeed = requiredCapability({ method });
        if (actualNeed !== needs) changes.push(`${method} needs ${actualNeed}, table says ${needs}`);
        function compare(column: string, expected: typeof owner, actual: "ok" | "refused") {
          const verdict = expected === "ok" ? expected : expected.verdict;
          if (actual !== verdict) changes.push(`${method} for ${column}: ${actual}, table says ${verdict}`);
          if (expected !== "ok" && expected.gated) gates.add(expected.file);
        }
        for (const [i, [caller, caps]] of Object.entries(ASK_CALLERS).entries()) {
          compare(caller, [owner, laptop, reader, ui][i], capabilityRefusal(caps, req) ? "refused" : "ok");
        }
        const hasPath = [...fencedPaths(req) ?? [], ...attachmentPaths(req) ?? [], ...workSources(req) ?? []].length > 0
          || JSON.stringify(ASK_PARAMS[method] ?? {}).includes(BOX_PATH);
        if (Boolean(paths) !== hasPath) changes.push(`${method}: fixture and table disagree on whether it carries a path`);
        if (paths && hasPath) {
          PLACES.forEach((place, i) => {
            if (place === "vm" && process.platform === "win32") return;
            const candidate = request(method, pathParams(method, root, place));
            compare(place, paths[i], fenceVerdict(candidate, root));
          });
        }
      }
      for (const file of gates) sourceFile(`src/renderer/src/${file}`);
      expect(changes).toEqual([]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
