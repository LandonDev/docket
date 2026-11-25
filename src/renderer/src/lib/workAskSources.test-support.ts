import ts from "typescript";
import { ClientRequestSchema } from "@shared/contract";
import { HEALTH_RUN_METHODS } from "@shared/work/health";
import { location, sourceFile, sourcePaths, visitSource } from "./guardSource.test-support";

const R = "src/renderer/src";
const WORK = `${R}/work`;
const SETTINGS = `${R}/surfaces/settings`;
const WIRE_PREFIXES = new Set(ClientRequestSchema.options.map(({ shape }) => shape.method.value.split(".")[0]));
const WRAPPERS = new Set(["ask", "call", "rpc", "act", "run", "guestsCall", "useAsked", "seeded", "useEachWorkspace", "change", "host", "onAct", "request", "askOf"]);
const isMethod = (text: string): boolean => /^[a-z][\w]*(?:\.[\w]+)+$/.test(text) && WIRE_PREFIXES.has(text.split(".")[0]);

// Work also presses these shared entry points. Read their bodies so a request they stop making falls out of the inventory.
const SHARED: Record<string, readonly string[]> = {
  "attachmentUpload.ts": ["attachmentSettings", "hostSource", "uploadFile"],
  "computerSessions.ts": ["load", "stopComputer"],
  "tcserver/commands.ts": ["createDraft", "ensureCreated", "send", "toServerAttachments", "readAttachment"],
  "tcserver/workspaces.ts": ["saveDefaults"],
  "tcserver/projects.ts": ["renameProject", "setProjectAccounts", "setWorkspaceAccounts"],
  "macBridge.ts": ["refreshMacBridgeHosts", "refreshMacBridgeLoad", "setMacBridgeComputer", "setMacBridgeLoadLimit", "setMacBridgePolicy", "setMacBridgeLimits", "setMacBridgeShared"],
};

const NATIVE = new Map([
  ["getPathForFile", "getPathForFile"],
  ["nativePlatform", "platform"],
  ["thisDesktopInLine", "platform"],
  ["openUrl", "app.openUrl"],
  ["saveDownload", "app.saveDownload"],
  ["printPdfFile", "printPdf"],
  ["openFullEditor", "app.openFullEditor"],
  ["systemNotice", "app.notice"],
  ["draftStore", "drafts"],
  ["pickFiles", "dialog.open"],
  ["pickFolder", "dialog.open"],
  ["revealPath", "revealInFinder"],
]);

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}

/** Follow literals, ternaries and the small same-file maps used as method arguments. */
function methodLiterals(arg: ts.Expression, constants: ReadonlyMap<string, ts.Expression>, seen = new Set<ts.Node>()): ts.StringLiteralLike[] {
  const node = unwrap(arg);
  if (seen.has(node)) return [];
  seen.add(node);
  if (ts.isStringLiteralLike(node)) return isMethod(node.text) ? [node] : [];
  if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse].flatMap((p) => methodLiterals(p, constants, seen));
  if (ts.isIdentifier(node)) {
    const init = constants.get(node.text);
    return init ? methodLiterals(init, constants, seen) : [];
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const base = unwrap(node.expression);
    const init = ts.isIdentifier(base) && constants.get(base.text);
    const map = init && unwrap(init);
    if (map && ts.isObjectLiteralExpression(map)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (key === undefined) return methodLiterals(map, constants, seen);
      const entry = map.properties.find((part) => ts.isPropertyAssignment(part) && asName(part.name) === key);
      if (entry && ts.isPropertyAssignment(entry)) return methodLiterals(entry.initializer, constants, seen);
    }
  }
  if (ts.isObjectLiteralExpression(node)) return node.properties.flatMap((p) => ts.isPropertyAssignment(p) ? methodLiterals(p.initializer, constants, seen) : []);
  return [];
}

const asName = (node: ts.Node): string | undefined => ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;

export function askSources() {
  const methods = new Map<string, Set<string>>();
  const preload = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, name: string, node: ts.Node) => {
    const sites = map.get(name) ?? new Set<string>();
    sites.add(location(node));
    map.set(name, sites);
  };
  const files = [
    ...sourcePaths(WORK),
    ...sourcePaths(`${R}/lib`).filter((file) => /^work[^/]*\.ts$/.test(file.slice(R.length + 5)) && !file.endsWith(".test-support.ts")),
    `${SETTINGS}/Work.tsx`, `${SETTINGS}/Workspace.tsx`,
    ...sourcePaths(`${SETTINGS}/hosts`),
  ];
  for (const file of [...files, ...Object.keys(SHARED).map((name) => `${R}/lib/${name}`)]) {
    const source = sourceFile(file);
    const names = SHARED[file.slice(R.length + 5)];
    const roots: ts.Node[] = names ? [] : [source];
    if (names) visitSource(source, (node) => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && names.includes(node.name.getText())) roots.push(node);
    });
    const constants = new Map<string, ts.Expression>();
    const native = new Map<string, string>();
    visitSource(source, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (node.parent.flags & ts.NodeFlags.Const)) {
        constants.set(node.name.text, node.initializer);
      }
      if (ts.isImportSpecifier(node)) {
        const spec = node.parent.parent.parent;
        if (!ts.isImportDeclaration(spec) || !/\/(native|fs)$/.test(spec.moduleSpecifier.getText().slice(1, -1))) return;
        const name = NATIVE.get((node.propertyName ?? node.name).text);
        if (name) native.set(node.name.text, name);
      }
    });

    for (const root of roots) visitSource(root, (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        const bridge = /^(?:globalThis\??\.)?window\??\.(api|tcShow|tcLive)\??\.([\w.?!]+)$/.exec(node.getText());
        if (bridge && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) {
          add(preload, bridge[1] === "api" ? bridge[2].replace(/[?!]/g, "") : bridge[1], node);
        }
        if (/^window\.(tcShow|tcLive)$/.test(node.getText())) add(preload, node.name.text, node);
        if (node.name.text === "captureKey" && file.endsWith("/CaptureKeyRow.tsx") && node.expression.getText().endsWith(".api")) add(preload, "captureKey", node);
      }
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
        : ts.isCallExpression(callee) ? asName(callee.expression) : asName(callee);
      if (!name) return;
      const nativeName = ts.isPropertyAccessExpression(callee) ? asName(callee.expression) : name;
      const bridge = nativeName && native.get(nativeName);
      if (bridge) add(preload, bridge, node);
      if (name === "invoke" && node.arguments[0]?.getText() === '"drag_files_out"') add(preload, "dragFilesOut", node);
      if (!WRAPPERS.has(name)) return;
      const methodAt = name === "rpc" ? 0 : name === "useEachWorkspace" ? 1
        : name === "request" && ts.isPropertyAccessExpression(callee) ? 0 : undefined;
      const args = methodAt === undefined ? node.arguments : node.arguments.slice(methodAt, methodAt + 1);
      for (const arg of args) {
        for (const literal of methodLiterals(arg, constants)) add(methods, literal.text, literal);
        // The two finite template families take their verbs from the code that offers them.
        if (ts.isTemplateExpression(arg) && arg.head.text === "work.winvm.") {
          visitSource(source, (part) => {
            if (ts.isPropertyAssignment(part) && asName(part.name) === "press" && ts.isStringLiteralLike(part.initializer)) {
              add(methods, arg.head.text + part.initializer.text, part.initializer);
            }
          });
        }
        if (ts.isTemplateExpression(arg) && arg.head.text === "work.files.") {
          visitSource(source, (part) => {
            if (ts.isParameter(part) && part.name.getText() === arg.templateSpans[0].expression.getText() && part.type && ts.isUnionTypeNode(part.type)) {
              for (const type of part.type.types) if (ts.isLiteralTypeNode(type) && ts.isStringLiteralLike(type.literal)) add(methods, arg.head.text + type.literal.text, type.literal);
            }
          });
        }
      }
      if (file.endsWith("/ConnectionsPage.tsx") && name === "request" && node.arguments[0]?.getText() === "fix.method") {
        for (const method of HEALTH_RUN_METHODS) add(methods, method, node);
      }
    });
  }
  return { methods, preload };
}
