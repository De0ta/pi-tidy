/** Real viewport input dispatch, including native OSC 8 links and global Ctrl+O. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssistantMessageComponent, CustomEditor, InteractiveMode,
  createEditToolDefinition, generateDiffString, initTheme, ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Container, getCapabilities, getOsc8LinkAtColumn, KeybindingsManager, ScrollView,
  setCapabilities, stripTerminalSequences, Text, TUI_KEYBINDINGS, TuiAltScreen, VStack,
} from "@earendil-works/pi-tui";
import { renderCompactFooter } from "../compact-footer.ts";
import { decorateQuietEditor } from "../editor-style.ts";
import { patchToolBoxFrames } from "../frame.ts";
import { resetGroups } from "../tool-groups.ts";

initTheme("dark");
const theme = (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")];
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Disabled Quiet still delegates via a new Container, state and last component. */
function wrappedDefinition() {
  const stock = createEditToolDefinition(process.cwd());
  return { ...stock,
    renderCall(args: any, theme: any, context: any) {
      const s = context.state;
      s.inner ??= {};
      s.root ??= new Container();
      s.root.clear();
      s.call = stock.renderCall!(args, theme, { ...context, state: s.inner, lastComponent: s.call });
      s.root.addChild(s.call);
      return s.root;
    },
    renderResult(result: any, options: any, theme: any, context: any) {
      const s = context.state;
      s.result = stock.renderResult!(result, options, theme, { ...context, state: s.inner, lastComponent: s.result });
      s.root.addChild(s.result);
      return new Container();
    },
  };
}

async function screen(width: number, count: number, followEnd = false, preview?: number, wrapped = false) {
  resetGroups();
  patchToolBoxFrames({ icons: true, groupTools: true, backgroundJobs: false,
    ...(preview === undefined ? {} : { diffLines: preview }) });
  const caps = getCapabilities();
  setCapabilities({ ...caps, hyperlinks: true });
  const terminal: any = {
    columns: width, rows: 24, kittyProtocolActive: false, isTTY: false,
    start(input: (data: string) => void) { this.input = input; }, stop() {}, async drainInput() {},
    write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, clearProgress() {},
  };
  const opened: string[] = [];
  const copied: string[] = [];
  const tui = new TuiAltScreen(terminal, false, undefined, {
    openUrl: (url) => { opened.push(url); },
    copyOnSelect: true,
    copySelection: async (text) => { copied.push(text); return true; },
  });
  const before = Array.from({ length: count }, (_, i) => `const BEFORE_${i} = ${i};`).join("\n");
  const after = before.replaceAll("BEFORE_", "AFTER_");
  const { diff } = generateDiffString(before, after);
  const args = { path: "mouse-edit.ts", edits: [{ oldText: before, newText: after }] };
  const callId = "mouse-edit-call";
  const tool = new ToolExecutionComponent("edit", callId, args, {}, wrapped ? wrappedDefinition() : createEditToolDefinition(process.cwd()), tui, process.cwd());
  tool.updateResult({ content: [{ type: "text", text: "ok" }], details: { diff }, isError: false } as any, false);
  tool.setArgsComplete();
  const chat = new Container();
  chat.addChild(new AssistantMessageComponent({ role: "assistant", stopReason: "toolUse", content: [
    { type: "thinking", thinking: "Checking this edit." },
    { type: "text", text: "Applying the change." },
    { type: "toolCall", id: callId, name: "edit", arguments: args },
  ] } as any, true));
  chat.addChild(tool);
  const scroll = new ScrollView(chat, { primary: true, follow: followEnd ? "end" : "none" });
  const kb = new KeybindingsManager({ ...TUI_KEYBINDINGS,
    "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand all tools" },
  });
  const editor = new CustomEditor(tui, {
    borderColor: (text: string) => theme.fg("border", text),
    selectList: {} as any,
  }, kb as any);
  const restore = decorateQuietEditor(editor, () => ({
    model: "Test model", thinking: "high",
    muted: (text) => theme.fg("muted", text), accent: (text) => theme.fg("accent", text),
  }));
  assert.ok(restore);
  editor.setText("unsent draft");
  // Use Pi's real command implementation, not component.setExpanded() as a
  // substitute for Ctrl+O. Its separate global flag intentionally stays native.
  const proto = InteractiveMode.prototype as any;
  const host: any = {
    toolOutputExpanded: false, chatContainer: chat, loadedResourcesContainer: new Container(),
    setToolsExpanded: proto.setToolsExpanded,
    showStatus() { tui.requestRender(); },
  };
  editor.onAction("app.tools.expand", () => proto.toggleToolOutputExpansion.call(host));
  tui.setLayoutRoot(new VStack([
    new Text("Session header", 0, 0),
    { component: scroll, basis: 0, grow: 1, minSize: 0 },
    editor,
    { render: (w: number) => renderCompactFooter({ cwd: process.cwd(), branch: null,
      session: "Mouse test", statuses: new Map([["subscription-usage", "5h 21% · 1w 60%"]]),
      dim: (text) => theme.fg("dim", text),
    }, w), invalidate() {} },
  ]));
  tui.setFocus(editor);
  tui.start();
  await tick();
  const raw = () => tui.getScreenLines();
  const lines = () => raw().map(stripTerminalSequences);
  const input = async (data: string) => { terminal.input(data); await tick(); };
  const click = async (x: number, y: number) => {
    terminal.input(`\x1b[<0;${x + 1};${y + 1}M`);
    await input(`\x1b[<0;${x + 1};${y + 1}m`);
  };
  const toggle = async (glyph: string) => {
    const row = lines().findIndex((line) => line.includes(glyph) && line.includes("mouse-edit.ts"));
    assert.ok(row >= 0, `visible ${glyph} control`);
    const x = lines()[row]!.indexOf(glyph);
    assert.equal(getOsc8LinkAtColumn(raw()[row]!, x), undefined, "control is outside the filename link");
    await click(x, row);
  };
  return { tui, tool, chat, scroll, editor, host, terminal, opened, copied, lines, raw, input, click, toggle,
    close() { tui.stop(); restore!(); setCapabilities(caps); resetGroups(); },
  };
}

for (const width of [60, 120]) {
  for (const count of [1, 40]) for (const wrapped of [false, true]) {
    test(`fullscreen ${width} columns, ${count}-line edit, wrapped ${wrapped}: pointer round trip and filename link`, async () => {
      const s = await screen(width, count, false, undefined, wrapped);
      try {
        const collapsedHeight = s.tool.render(width).length;
        assert.equal((s.tool as any).expanded, false);
        assert.ok(!s.lines().some((line) => line.includes("AFTER_")), "default collapse has no preview rows");
        assert.equal(s.lines().filter((line) => line.includes("mouse-edit.ts")).length, 1, "wrapper must not duplicate the header or leak the native body");
        const row = s.lines().findIndex((line) => line.includes("mouse-edit.ts"));
        const x = s.lines()[row]!.indexOf("mouse-edit.ts") + 2;
        assert.ok(getOsc8LinkAtColumn(s.raw()[row]!, x));
        await s.click(x, row);
        assert.equal(s.opened.length, 1);
        assert.equal((s.tool as any).expanded, false, "native filename activation is not folding");
        await s.toggle("▸");
        assert.equal((s.tool as any).expanded, true);
        assert.ok(s.tool.render(width).length > collapsedHeight, "even a one-line edit visibly opens");
        assert.ok(s.lines().some((line) => /BEFORE_|AFTER_/.test(line)), "visible diff rows");
        assert.ok(s.tool.render(width).map(stripTerminalSequences).some((line) => line.includes(`AFTER_${count - 1}`)), "all added rows are present");
        await s.toggle("▾");
        assert.equal((s.tool as any).expanded, false);
        assert.equal(s.tool.render(width).length, collapsedHeight);
        assert.ok(!s.lines().some((line) => line.includes("AFTER_")));
        assert.equal(s.opened.length, 1);
        assert.equal(s.editor.getText(), "unsent draft");
      } finally { s.close(); }
    });
  }
}

test("fullscreen follows a growing edit; visible body can close it without breaking selection or scrolling", async () => {
  const s = await screen(120, 60, true);
  try {
    await s.toggle("▸");
    assert.equal((s.tool as any).expanded, true);
    assert.ok(s.scroll.scrollTop > 0);
    const bottom = s.scroll.scrollTop;
    await s.input("\x1b[<64;12;8M");
    assert.ok(s.scroll.scrollTop < bottom, "native wheel scroll still works");
    let row = s.lines().findIndex((line) => line.includes("AFTER_"));
    assert.ok(row >= 0);
    s.terminal.input(`\x1b[<0;8;${row + 1}M`);
    s.terminal.input(`\x1b[<32;20;${row + 1}M`);
    await s.input(`\x1b[<0;20;${row + 1}m`);
    assert.equal((s.tool as any).expanded, true, "drag must not toggle");
    assert.ok(s.copied.length > 0, "native selection can still copy");
    row = s.lines().findIndex((line) => line.includes("AFTER_"));
    await s.click(8, row);
    assert.equal((s.tool as any).expanded, false);
    assert.ok(s.lines().some((line) => line.includes("▸") && line.includes("mouse-edit.ts")));
  } finally { s.close(); }
});

test("actual Ctrl+O through the focused editor keeps Pi's global semantics after a pointer toggle", async () => {
  const s = await screen(120, 4);
  try {
    await s.toggle("▸");
    assert.equal((s.tool as any).expanded, true);
    assert.equal(s.host.toolOutputExpanded, false);
    await s.input("\x0f");
    assert.equal(s.host.toolOutputExpanded, true);
    assert.equal((s.tool as any).expanded, true, "first global expand does not close a pointer-opened box");
    await s.input("\x0f");
    assert.equal(s.host.toolOutputExpanded, false);
    assert.equal((s.tool as any).expanded, false);
    assert.ok(!s.lines().some((line) => line.includes("AFTER_")));
    assert.equal(s.editor.getText(), "unsent draft");
  } finally { s.close(); }
});

test("an explicit positive preview budget keeps the chevron state even when the heights match", async () => {
  const s = await screen(120, 1, false, 20);
  try {
    const height = s.tool.render(120).length;
    assert.ok(s.lines().some((line) => line.includes("AFTER_")));
    await s.toggle("▸");
    assert.equal(s.tool.render(120).length, height);
    await s.toggle("▾");
    assert.equal((s.tool as any).expanded, false);
  } finally { s.close(); }
});
