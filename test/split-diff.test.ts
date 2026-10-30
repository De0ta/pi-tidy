/**
 * The two-pane edit diff: the pure renderer, and the same thing through pi's
 * real ToolExecutionComponent (which is where the frame patch hooks it in).
 *
 * Runs in its own process, so the options set here stay here.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createEditToolDefinition,
  generateDiffString,
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../frame.ts";
import { renderSplitDiff } from "../split-diff.ts";

initTheme("dark");
const theme = globalThis as unknown as Record<symbol, any>;
const t = theme[Symbol.for("@earendil-works/pi-coding-agent:theme")];

const WIDTH = 100;

const BEFORE = `export const label = "before";
export function greet(name: string) {
  return \`hello \${name}\`;
}
`;

const AFTER = `export const label = "après café";
export function greet(name: string) {
  added line
  return \`hello \${name}\`;
}
`;

const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, "");

function sample(width = WIDTH) {
  const { diff } = generateDiffString(BEFORE, AFTER);
  return renderSplitDiff({ diff, width, theme: t, filePath: "sample.ts" });
}

test("pairs removed and added lines into two panes", () => {
  const out = sample();
  assert.ok(out, "expected a split at this width");
  const text = out.lines.map(plain);
  assert.match(text[0] ?? "", /↳ diff \+\d+ -\d+ \[\++-*\]/);
  assert.match(text[1] ?? "", /old\s+│\s+new/);
  // The single-line replacement is one row with both sides on it.
  const changed = text.find((line) => line.includes("before"));
  assert.ok(changed?.includes("après café"), "removed and added text share a row");
  // The inserted line has no partner on the left: blank pane, then the added one.
  const inserted = text.find((line) => line.includes("added line"));
  assert.ok(inserted?.includes("│"), "the pane rule stays so both columns align");
  assert.ok(!inserted!.split("│")[0]!.trim(), "the left pane of a one-sided row is blank");
});

test("rows are exactly the requested width", () => {
  for (const width of [72, 80, 100, 137]) {
    const out = sample(width);
    assert.ok(out, `expected a split at ${width}`);
    for (const line of out.lines) {
      assert.equal(visibleWidth(line), width, `row width at ${width}`);
    }
  }
});

test("narrow boxes fall back to the unified diff", () => {
  assert.equal(sample(40), null);
  assert.equal(sample(48), null);
  // The frame decides the real threshold from `splitDiffMinWidth`; the
  // renderer only refuses what cannot be laid out at all.
  assert.ok(sample(60));
});

test("changed rows are the ones carrying a background", () => {
  const out = sample();
  assert.ok(out);
  assert.ok(out.bgRows.length >= 2, "at least the replacement pair is tinted");
  for (const row of out.bgRows) {
    const line = out.lines[row] ?? "";
    assert.match(line, /\x1b\[48;2;/, "tinted rows carry a truecolor fill");
    assert.ok(plain(line).includes("before") || plain(line).includes("après") || plain(line).trim() !== "");
  }
  // Context rows stay transparent: the frame strips anything we do not mark.
  const contextRow = out.lines.findIndex((line) => plain(line).includes("export function"));
  assert.ok(!out.bgRows.includes(contextRow));
});

test("the word that changed is emphasised inside the row fill", () => {
  const out = sample();
  assert.ok(out);
  const row = out.lines.find((line) => plain(line).includes("après café")) ?? "";
  // Two different fills on one row: the row tint and the stronger word tint.
  const fills = new Set([...row.matchAll(/\x1b\[48;2;([0-9;]+)m/g)].map((match) => match[1]));
  assert.ok(fills.size >= 2, `expected a word-level fill inside the row fill, got ${fills.size}`);
});

test("control characters from file content never reach the terminal", () => {
  const { diff } = generateDiffString("a\n", "b\u001b[2Jc\n");
  const out = renderSplitDiff({ diff, width: WIDTH, theme: t });
  assert.ok(out);
  assert.ok(!out.lines.some((line) => line.includes("\u001b[2J")));
});

// ── through pi's real edit box ──────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "pi-tidy-split-"));
const cwd = dir;
const editDef = createEditToolDefinition(cwd);
const ui = { requestRender: () => {} };
patchToolBoxFrames({ icons: false, splitDiff: true, splitDiffMinWidth: 72, diffLines: 20 });

/** pi computes the preview asynchronously (it reads the file); give it a beat. */
async function editBox(path: string, width: number): Promise<string[]> {
  const file = join(dir, path);
  writeFileSync(file, BEFORE);
  const component = new ToolExecutionComponent(
    "edit",
    `call-${path}`,
    { path: file, edits: [{ oldText: 'export const label = "before";', newText: 'export const label = "après café";' }] },
    {},
    editDef as any,
    ui as any,
    cwd,
  );
  component.setArgsComplete();
  const lines = () => {
    return component.render(width);
  };
  lines();
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const out = lines();
    if (out.some((line) => plain(line).includes("old"))) return out;
  }
  return lines();
}

test("pi's edit box renders the split diff at a wide width", async () => {
  const lines = await editBox("wide.ts", 100);
  const text = lines.map(plain).join("\n");
  assert.match(text, /old\s+│\s+new/, text);
  assert.match(text, /après café/);
  // The tinted rows survive the frame's background stripping.
  assert.ok(lines.some((line) => /\x1b\[48;2;/.test(line)), "row fill kept by the frame");
});

test("pi's edit box keeps pi's unified diff when the box is narrow", async () => {
  const lines = await editBox("narrow.ts", 60);
  const text = lines.map(plain).join("\n");
  assert.ok(!text.includes("│ new"), text);
  assert.match(text, /après café|\+1 /, text);
});

// ─────────────────────────────────────────────────────────────────────────────
// diffLines: the collapsed body is a window anchored at the first change
// ─────────────────────────────────────────────────────────────────────────────

/** A 60-line file where most of the lines changed — a diff with many rows. */
function longSample(budget?: number) {
  const before = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before
    .split("\n")
    .map((line, i) => (i >= 20 ? `${line} CHANGED` : line))
    .join("\n");
  const { diff } = generateDiffString(before, after);
  const out = renderSplitDiff({ diff, width: WIDTH, theme: t, filePath: "long.ts", maxLines: budget });
  assert.ok(out);
  return out.lines.map(plain);
}

test("the body is clipped to the budget, and says what it left out", () => {
  const all = longSample();
  const clipped = longSample(10);
  assert.ok(clipped.length < all.length, "the collapsed body is shorter");
  // A third of the budget of context above the first change: it is still there.
  assert.ok(clipped.some((line) => line.includes("line 21 CHANGED")), "the first change survives the window");
  const footer = clipped.at(-1) ?? "";
  assert.match(footer, /… \(\d+ more lines, \d+ total,/);
  assert.match(footer, /to expand/);
  assert.match(clipped[1] ?? "", /old\s+│\s+new/, "the panes header stays put");
});

test("a window that starts below the top says how many lines it skipped", () => {
  const clipped = longSample(6);
  const above = clipped.find((line) => /… \d+ lines above/.test(line));
  assert.ok(above, `expected an "above" marker, got:\n${clipped.join("\n")}`);
});

test("budget 0 is the summary and the totals — no column header over nothing", () => {
  const none = longSample(0);
  assert.match(none[0] ?? "", /↳ diff \+40 -40/);
  assert.equal(none.filter((line) => line.includes("old")).length, 0, "no old/new header");
  assert.equal(none.filter((line) => /field|line \d/.test(line)).length, 0, "no diff rows");
  assert.match(none.at(-1) ?? "", /… \(\d+ more lines/);
});

test("no budget draws every row — that is what ctrl+o does", () => {
  const all = longSample();
  assert.doesNotMatch(all.join("\n"), /more lines, \d+ total/);
  assert.ok(all.some((line) => line.includes("line 60 CHANGED")));
});

test("a collapsed edit box is clipped to diffLines; setExpanded draws all of it", async () => {
  const before = Array.from({ length: 40 }, (_, i) => `const k${i} = ${i};`).join("\n");
  const after = before.replaceAll("const k", "let  k");
  const file = join(dir, "big.ts");
  writeFileSync(file, before);
  const component = new ToolExecutionComponent(
    "edit",
    "call-big",
    { path: file, edits: [{ oldText: before, newText: after }] },
    {},
    editDef as any,
    ui as any,
    cwd,
  );
  component.setArgsComplete();
  const settle = async () => {
    let out = component.render(100);
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      out = component.render(100);
      if (plain(out.join("\n")).includes("old")) return out;
    }
    return out;
  };

  const clipped = (await settle()).map(plain);
  const clippedText = clipped.join("\n");
  assert.match(clippedText, /more lines, \d+ total,/, clippedText);
  assert.ok(clipped.length < 40, `collapsed box stays small (${clipped.length} rows)`);

  component.setExpanded(true);
  const full = (await settle()).map(plain);
  assert.doesNotMatch(full.join("\n"), /more lines, \d+ total,/);
  assert.ok(full.length > clipped.length, "expanded draws the rest");
  assert.match(full.join("\n"), /let  k39/, "the change at the bottom is there");
});
