#!/usr/bin/env bun
/**
 * An experiment for the renderer soak's `--eval` (docs/agents/loading-bones.md "Measured"): a panel of sample rows
 * over the window's right side, measured and drawn in bones by Skullet's own inline script (the one a still preview
 * page runs), so the bones' loop runs beside whatever the scene streams.
 *
 *   bun scripts/measure-renderer-soak.ts --gate --scene chat --cpu-report-only --trace 5 --label bones-sweep \
 *     --eval "$(bun scripts/soak-bones-eval.ts shimmer 70)"
 *
 * The first argument is Skullet's animation (`shimmer`, `pulse`, `none`), the second the rows (four bones a row).
 */
import { INLINE_SCRIPT } from 'skullet/internal'

const [animation = 'shimmer', rows = '70'] = process.argv.slice(2)
if (!['shimmer', 'group-shimmer', 'pulse', 'none'].includes(animation) || !Number.isSafeInteger(Number(rows))) {
  console.error('Usage: bun scripts/soak-bones-eval.ts [shimmer|group-shimmer|pulse|none] [rows]')
  process.exit(2)
}

process.stdout.write(`(() => {
  const panel = document.createElement("div");
  panel.id = "soak-bones";
  panel.style.cssText = "position:fixed;top:44px;right:0;bottom:0;width:380px;z-index:80;overflow:hidden;background:var(--background);border-left:1px solid var(--border);--skullet-animation:${animation}";
  const root = document.createElement("div");
  root.setAttribute("skullet-loading", "");
  const ghost = document.createElement("div");
  ghost.setAttribute("skullet-ghost", "");
  const titles = ["Review the release notes", "Check what changed on the box", "Plan the next pass", "Ask about the tunnel's port", "Sort the reading list"];
  const lines = ["What changed, and what to check first", "Three things to ask before Friday", "Fewer rows, the same reach", "Two papers and a long thread"];
  let html = "";
  for (let i = 0; i < ${Number(rows)}; i++) html += '<div style="display:flex;gap:8px;align-items:flex-start;padding:4px 12px;height:44px;box-sizing:border-box"><span skullet-block style="display:block;width:16px;height:16px;border-radius:4px;flex:none;margin-top:2px"></span><div style="flex:1;min-width:0"><p style="margin:0;font-size:13px;line-height:20px">' + titles[i % titles.length] + '</p><p style="margin:0;font-size:12px;line-height:16px">' + lines[i % lines.length] + '</p></div><span style="font-size:12px;line-height:20px">' + (i % 9 + 1) + 'h</span></div>';
  ghost.innerHTML = html;
  const layer = document.createElement("div");
  layer.setAttribute("skullet-layer", "");
  root.append(ghost, layer);
  const mark = document.createElement("i");
  panel.append(root, mark);
  document.body.append(panel);
  ${INLINE_SCRIPT}
  self[Symbol.for("skullet.boot")](mark);
  return "bones: " + (layer.shadowRoot ? layer.shadowRoot.children.length : 0) + " bars";
})()`)
