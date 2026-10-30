/** Long edit previews must visibly toggle in every layout, not just flip a flag. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, createEditToolDefinition, generateDiffString, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../frame.ts";
import { resetGroups } from "../tool-groups.ts";
import { createSplitDiffRenderer, renderUnifiedDiff } from "../split-diff.ts";

initTheme("dark");
const theme = (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")];
const cwd = process.cwd();
const definition = createEditToolDefinition(cwd);
const ui = { requestRender() {} };
const before = Array.from({ length: 40 }, (_, i) => `const BEFORE_${i} = ${i};`).join("\n");
const after = before.replaceAll("BEFORE_", "AFTER_");
const { diff } = generateDiffString(before, after);
let id = 0;
function editBox() {
  const component = new ToolExecutionComponent("edit", `edit-${++id}`, {
    path: "long-edit.ts", edits: [{ oldText: before, newText: after }],
  }, {}, definition as any, ui as any, cwd);
  // History supplies the result before args-complete. No filesystem preview is needed.
  component.updateResult({ content: [{ type: "text", text: "ok" }], details: { diff }, isError: false } as any, false);
  component.setArgsComplete();
  component.setExpanded(false);
  return component;
}
function text(value: string) {
  return new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: value }], stopReason: "stop" } as any);
}
const clean = (lines: string[]) => lines.map(stripTerminalSequences);
function click(chat: Container, width: number, needle: string, type = "click", button = "left") {
  const lines = clean(chat.render(width));
  const y = lines.findIndex((line) => line.includes(needle));
  assert.ok(y >= 0, `missing ${needle}:\n${lines.join("\n")}`);
  return chat.handleMouse({ type, button, x: 6, y, screenX: 6, screenY: y, width, height: lines.length } as any);
}

for (const mode of [
  { name: "wide split", width: 100, splitDiff: true, splitDiffMinWidth: 72 },
  { name: "narrow unified", width: 60, splitDiff: true, splitDiffMinWidth: 72 },
  { name: "split disabled", width: 100, splitDiff: false, splitDiffMinWidth: 72 },
  { name: "split layout refuses width", width: 40, splitDiff: true, splitDiffMinWidth: 1 },
]) {
  for (const groupTools of [true, false]) test(`${mode.name}, grouping ${groupTools}: header/body clicks and Ctrl+O visibly expand/collapse`, () => {
    resetGroups();
    patchToolBoxFrames({ icons: false, groupTools, ...mode, diffLines: 5 });
    const component = editBox();
    const chat = new Container();
    chat.addChild(text("Before the edit."));
    chat.addChild(component);
    chat.addChild(text("After the edit."));
    const collapsed = clean(chat.render(mode.width));
    assert.ok(collapsed.some((line) => line.includes("more lines")));
    assert.ok(!collapsed.some((line) => line.includes("AFTER_39")));
    assert.ok(click(chat, mode.width, "long-edit.ts"));
    const expanded = clean(chat.render(mode.width));
    assert.ok(expanded.length > collapsed.length);
    assert.ok(expanded.some((line) => line.includes("AFTER_39")));
    assert.ok(!expanded.some((line) => line.includes("more lines")));
    assert.ok(click(chat, mode.width, "AFTER_39"));
    assert.deepEqual(clean(chat.render(mode.width)), collapsed);

    component.setExpanded(true); // the same entry point as Pi's Ctrl+O
    assert.ok(clean(chat.render(mode.width)).some((line) => line.includes("AFTER_39")));
    component.setExpanded(false);
    assert.deepEqual(clean(chat.render(mode.width)), collapsed);
    assert.ok(collapsed.some((line) => line.includes("long-edit.ts")), "pinned edit remains its own box");
    assert.ok(!collapsed.some((line) => /\d+ calls? ·/.test(line)), "edit is not folded into a group");
    for (const [type, button] of [["click", "right"], ["press", "left"], ["drag", "left"]]) {
      assert.equal(click(chat, mode.width, "long-edit.ts", type, button), undefined);
      assert.deepEqual(clean(chat.render(mode.width)), collapsed);
    }
  });
}

test("zero/live budgets and resize retain the expansion policy for the same edit", () => {
  const options = { icons: false, groupTools: false, splitDiff: true, diffLines: 0 };
  patchToolBoxFrames(options);
  const component = editBox();
  for (const width of [100, 60, 100]) {
    const lines = clean(component.render(width));
    assert.ok(lines.some((line) => line.includes("↳ diff")));
    assert.ok(lines.some((line) => line.includes("more lines")));
    assert.ok(!lines.some((line) => /BEFORE_|AFTER_/.test(line)));
  }
  patchToolBoxFrames({ ...options, diffLines: 7 });
  for (const width of [60,100,60]) {
    const lines = component.render(width);
    assert.ok(lines.length > 5);
    assert.ok(lines.length < 20);
    assert.ok(clean(lines).some((line) => /BEFORE_|AFTER_/.test(line)));
    lines.forEach((line) => assert.ok(visibleWidth(line) <= width));
  }
  component.setExpanded(true);
  component.invalidate();
  for (const width of [60,100]) assert.ok(clean(component.render(width)).some((line) => line.includes("AFTER_39")));
});

test("unified window shows the first change, sanitizes controls and caches only its owner", () => {
  const source = Array.from({ length: 60 }, (_,i) => `context ${i}`).join("\n");
  const { diff: lateDiff } = generateDiffString(source, source.replace("context 50", "CHANGED 中文 👩‍💻\x1b[2J"));
  const input = { diff: lateDiff, width: 54, theme, maxLines: 5 };
  const renderA = createSplitDiffRenderer(renderUnifiedDiff);
  const renderB = createSplitDiffRenderer(renderUnifiedDiff);
  const a = renderA(input)!;
  renderB({ ...input, diff });
  assert.equal(renderA(input), a);
  assert.ok(clean(a.lines).some((line) => line.includes("CHANGED")));
  assert.ok(!a.lines.join("").includes("\x1b[2J"));
  a.lines.forEach((line) => assert.equal(visibleWidth(line), 54));
  assert.notEqual(renderA({ ...input, maxLines: undefined }), a);
});

test("wrapped context beginning with +/- does not hide the actual change", () => {
  for (const marker of ["---- ", "++++ "]) {
    const context = marker.repeat(100);
    const { diff } = generateDiffString(`${context}\nBEFORE\nlast`, `${context}\nAFTER\nlast`);
    const out = renderUnifiedDiff({ diff, width: 54, theme, maxLines: 5 })!;
    assert.match(clean(out.lines).join("\n"), /AFTER/);
    assert.ok(out.lines.length <= 8);
  }
});

test("alternating real unified edit boxes keep their own cached body until content/layout invalidates", () => {
  patchToolBoxFrames({ icons: false, groupTools: false, splitDiff: false, diffLines: 5 });
  const a = editBox();
  const b = editBox();
  const fg = theme.fg;
  let builds = 0;
  theme.fg = function (color: string, text: string) {
    if (color === "toolDiffAdded" && text === "x") builds++;
    return fg.call(this, color, text);
  };
  try {
    a.render(60);
    b.render(60);
    const warm = builds;
    assert.ok(warm > 0);
    for (let i = 0; i < 5; i++) { a.render(60); b.render(60); }
    assert.equal(builds, warm);
    a.invalidate();
    a.render(60);
    assert.ok(builds > warm);
    const invalidated = builds;
    b.render(60);
    assert.equal(builds, invalidated, "invalidating A must not evict B");
    a.updateResult({ content: [{ type: "text", text: "ok" }], details: { diff: diff.replaceAll("AFTER_", "UPDATED_") }, isError: false } as any, false);
    a.setExpanded(true);
    assert.match(clean(a.render(60)).join("\n"), /UPDATED_39/);
  } finally { theme.fg = fg; }
});

test("a failed edit keeps Pi's error even if a successful diff preview remains", () => {
  patchToolBoxFrames({ icons: false, splitDiff: true });
  const component = editBox();
  component.updateResult({ content: [{ type: "text", text: "permission denied" }], isError: true } as any, false);
  for (const width of [60,100]) assert.match(clean(component.render(width)).join("\n"), /permission denied/);
});
