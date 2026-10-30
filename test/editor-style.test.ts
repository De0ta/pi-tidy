/** Real native editors; presentation must not replace their editing machinery. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider, CURSOR_MARKER, Editor, KeybindingsManager,
  setKeybindings, stripTerminalSequences, visibleWidth, TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { decorateQuietEditor, registerEditorStyle, type QuietEditorInfo } from "../editor-style.ts";

const identity = (text: string) => text;
const theme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
// CustomEditor's app layer delegates all other keys to the real native editor.
const keys = { matches: (data: string, action: string) => action === "app.interrupt" && data === "\x1b" } as any;
function ui() {
  return { terminal: { rows: 30, columns: 80 }, renders: 0, requestRender() { this.renders++; } } as any;
}
function editor(options = {}) {
  const instance = new CustomEditor(ui(), theme, keys, options);
  instance.focused = true;
  return instance;
}
function metadata(): QuietEditorInfo {
  return { model: "DeepSeek Flash", thinking: "high", muted: identity, accent: identity };
}
const plain = (lines: string[]) => lines.map(stripTerminalSequences);
const mouse = (x: number, y: number, width = 80, type = "click") => ({ x, y, width, height: 15, type, button: "left", shiftKey: false, ctrlKey: false, altKey: false }) as any;

test("quiet decorates the original instance; cleanup restores exact descriptors and never input", () => {
  const instance = editor();
  const input = instance.handleInput;
  const names = ["render", "handleMouse", "renderTopBorder", "renderBottomBorder"];
  Object.defineProperty(instance, "render", { configurable: true, writable: false, enumerable: true, value: Editor.prototype.render });
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(instance, name));
  const restore = decorateQuietEditor(instance, metadata);
  assert.ok(restore);
  assert.equal(instance.handleInput, input);
  instance.setText("Hello 中文");
  const lines = plain(instance.render(80));
  assert.equal(lines.length, 3, "no extra workspace/session row above the input");
  assert.match(lines[0]!, /^╭.*╮$/);
  assert.match(lines[1]!, /^│ ❯ .*Hello 中文/);
  assert.match(lines.at(-1)!, /DeepSeek Flash \(high\).*╯$/);
  restore();
  restore();
  names.forEach((name, i) => assert.deepEqual(Object.getOwnPropertyDescriptor(instance, name), descriptors[i]));
  assert.equal(instance.getText(), "Hello 中文");
  assert.equal(instance.handleInput, input);
});

test("CJK, emoji, combining marks, long names and resizes fit columns and retain one IME marker", () => {
  const instance = editor({ paddingX: 1 });
  const info = metadata();
  info.model = "模型 👩‍💻 e\u0301".repeat(15) + "\x1b[2J\n";
  decorateQuietEditor(instance, () => info);
  const draft = "中文输入 👩‍💻 e\u0301\n多行草稿".repeat(20);
  instance.setText(draft);
  for (const width of [0, 1, 2, 3, 4, 8, 11, 12, 13, 16, 24, 80, 140, 30, 120]) {
    const lines = instance.render(width);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
      assert.ok(!line.includes("\x1b[2J"));
    }
    assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, width ? 1 : 0, `IME marker at ${width}`);
    assert.equal(instance.getText(), draft);
    if (width >= 12) {
      assert.match(plain(lines)[0]!, /^╭.*╮$/);
      assert.match(plain(lines).at(-1)!, /^╰.*╯$/);
      assert.equal(visibleWidth(lines.at(-1)!), width);
    }
  }
});

test("native working status and draft overflow indicators remain native", () => {
  const instance = editor({ embedWorkingStatus: true });
  instance.setWorkingStatusIndicator({ renderInBorder: () => "Working native", renderSpinnerInBorder: () => "*" } as any);
  decorateQuietEditor(instance, metadata);
  instance.setText(Array.from({ length: 30 }, (_,i) => `draft ${i}`).join("\n"));
  const lines = plain(instance.render(120));
  assert.match(lines[0]!, /Working native/);
  assert.match(lines[0]!, /↑ \d+ more/);
  assert.equal(lines.join("").split("Working native").length - 1, 1);
  instance.handleInput("\x1b[H"); // Home doesn't clear/replace the multiline draft.
  assert.match(instance.getText(), /draft 29/);
});

test("keyboard editing, history, bracketed paste, undo, app shortcuts and submit stay native", () => {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.historyPrevious": "ctrl+p", "tui.editor.historyNext": "ctrl+n" }));
  const native = editor();
  const quiet = editor();
  decorateQuietEditor(quiet, metadata);
  const submitted: string[][] = [[], []];
  let escapes = 0;
  for (const [index, instance] of [native, quiet].entries()) {
    instance.addToHistory("历史一");
    instance.addToHistory("history two");
    instance.onEscape = () => escapes++;
    instance.onSubmit = (text) => submitted[index]!.push(text);
  }
  const largePaste = Array.from({ length: 20 }, (_,i) => `第 ${i} 行 👩‍💻`).join("\n");
  const sequences = ["draft", "\x10", "\x10", "\x0e", "\x0e", "\x01", "前缀", "\x05", "\x1b[200~", "\n中文 e\u0301", "\x1b[201~", "\x1b[D", "\x7f", "\x1b[200~" + largePaste + "\x1b[201~", "\x1f", "\x1b", "\r"];
  for (const data of sequences) {
    native.render(74);
    quiet.render(80);
    native.handleInput(data);
    quiet.handleInput(data);
    assert.equal(quiet.getText(), native.getText(), `text after ${JSON.stringify(data)}`);
    assert.equal(quiet.getExpandedText(), native.getExpandedText());
    assert.deepEqual(quiet.getCursor(), native.getCursor());
  }
  assert.deepEqual(submitted[0], submitted[1]);
  assert.equal(submitted[0]!.length, 1);
  assert.equal(escapes, 2);
  // A collapsed paste remains expandable and submits the actual text.
  const pasted = editor();
  decorateQuietEditor(pasted, metadata);
  pasted.handleInput("\x1b[200~" + largePaste + "\x1b[201~");
  assert.notEqual(pasted.getText(), largePaste);
  assert.equal(pasted.getExpandedText(), largePaste);
  let result = "";
  pasted.onSubmit = (text) => { result = text; };
  pasted.handleInput("\r");
  assert.equal(result, largePaste);
});

test("mouse cursor geometry matches native, while drag/wheel remain unhandled", () => {
  const native = editor({ paddingX: 1 });
  const quiet = editor({ paddingX: 1 });
  decorateQuietEditor(quiet, metadata);
  for (const width of [80, 32, 12, 8]) {
    for (const instance of [native, quiet]) instance.setText("中文 ab 👩‍💻\nsecond line");
    native.render(width < 12 ? Math.max(4, width) : width - 6);
    quiet.render(width);
    const xOffset = width < 12 ? 0 : 4;
    for (const [x,y] of [[1,1],[3,1],[4,2]]) {
      native.handleMouse(mouse(x!,y!,width < 12 ? Math.max(4,width) : width - 6));
      quiet.handleMouse(mouse(x! + xOffset,y!,width));
      assert.deepEqual(quiet.getCursor(), native.getCursor(), `cursor at width ${width}`);
    }
    assert.equal(quiet.handleMouse(mouse(5,2,width,"drag")), undefined);
    assert.equal(quiet.handleMouse(mouse(5,2,width,"wheel")), undefined);
    if (width >= 12) assert.deepEqual(quiet.handleMouse(mouse(5,0,width)), native.handleMouse(mouse(1,0,width - 6)));
  }
});

test("a later border/layout replacement falls back with native mouse coordinates", () => {
  const instance = editor({ paddingX: 1 });
  const native = editor({ paddingX: 1 });
  const restore = decorateQuietEditor(instance, metadata)!;
  const laterBottom = (width: number) => "─".repeat(width);
  Reflect.set(instance, "renderBottomBorder", laterBottom);
  for (const current of [instance, native]) current.setText("中文 abcd");
  assert.equal(instance.render(80).length, native.render(80).length);
  instance.handleMouse(mouse(6,1));
  native.handleMouse(mouse(6,1));
  assert.deepEqual(instance.getCursor(), native.getCursor());
  restore();
  assert.equal(Reflect.get(instance, "renderBottomBorder"), laterBottom);
});

test("native completion stays below the border; keyboard and mouse completion work after resize", async () => {
  const instance = editor();
  decorateQuietEditor(instance, metadata);
  instance.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "alpha" }, { name: "alpine" }], process.cwd()));
  instance.handleInput("/a");
  instance.handleInput("\t");
  await delay(100);
  assert.equal(instance.isShowingAutocomplete(), true);
  for (const width of [80, 32, 12, 80]) {
    const lines = instance.render(width);
    const clean = plain(lines);
    const end = clean.findIndex((line) => line.startsWith("╰"));
    assert.ok(end >= 2);
    assert.ok(clean.slice(end + 1).some((line) => line.includes(width < 16 ? "al" : "alpha")));
    assert.ok(clean.slice(end + 1).every((line) => !line.startsWith("│")));
    assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  instance.handleInput("\x1b[B");
  instance.handleInput("\t");
  assert.match(instance.getText(), /^\/alpine/);
  instance.setText("");
  instance.handleInput("/a");
  instance.handleInput("\t");
  await delay(100);
  const lines = plain(instance.render(80));
  const end = lines.findIndex((line) => line.startsWith("╰"));
  const target = lines.findIndex((line,index) => index > end && line.includes("alpha"));
  assert.ok(target > end);
  instance.handleMouse(mouse(6,target,80));
  assert.match(instance.getText(), /^\/alpha/);
});

function harness(style: "native" | "quiet" = "quiet", previous?: any) {
  const handlers = new Map<string, Function[]>();
  let factory = previous;
  let current: any;
  const notices: string[] = [];
  const tui = ui();
  let name = "Old session";
  let thinking = "high";
  const ctx = {
    hasUI: true, mode: "tui", cwd: "D:\\someVibeThings\\pi-tidy", model: { name: "First model", id: "first" },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      getEditorComponent: () => factory,
      setEditorComponent: (value: any) => { factory = value; current = value?.(tui, theme, keys); },
      notify: (text: string) => notices.push(text),
    },
  } as any;
  const pi = {
    on: (event: string, fn: Function) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    getThinkingLevel: () => thinking,
    getSessionName: () => name,
  } as any;
  registerEditorStyle(pi, style);
  const emit = (event: string, context = ctx) => handlers.get(event)?.forEach((fn) => fn({}, context));
  return { pi,ctx,emit,handlers,notices,tui, get current() { return current; }, get factory() { return factory; }, setName: (value: string) => { name = value; }, setThinking: (value: string) => { thinking = value; } };
}

test("native style is a complete no-op; non-TUI mode never claims the factory", () => {
  const native = harness("native");
  assert.equal(native.handlers.size, 0);
  assert.equal(native.factory, undefined);
  for (const mode of ["rpc","print","json"]) {
    const h = harness();
    h.ctx.mode = mode;
    h.ctx.ui.getEditorComponent = () => { throw new Error("should not inspect editor"); };
    h.emit("session_start");
    assert.equal(h.factory, undefined);
  }
});

test("missing public factory APIs warn rather than replacing any UI", () => {
  const h = harness();
  delete h.ctx.ui.getEditorComponent;
  h.emit("session_start");
  assert.equal(h.factory, undefined);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0]!, /factory API/);
});

test("model, thinking and theme changes repaint labels without replacing editor state", () => {
  const h = harness();
  h.emit("session_start");
  const instance = h.current;
  instance.focused = true;
  instance.setText("多行\n草稿");
  const factory = h.factory;
  assert.match(plain(instance.render(100)).at(-1)!, /First model \(high\)/);
  h.ctx.model = { name: "Changed model" };
  h.setThinking("xhigh");
  h.emit("model_select");
  h.emit("thinking_level_select");
  let lines = instance.render(100);
  assert.match(plain(lines).at(-1)!, /Changed model \(xhigh\)/);
  assert.equal(h.tui.renders, 2);
  h.ctx.ui.theme = { fg: (_color: string, text: string) => `\x1b[35m${text}\x1b[39m` };
  lines = instance.render(100);
  assert.ok(lines.at(-1)!.includes("\x1b[35m"));
  h.setThinking("off");
  assert.ok(!plain(instance.render(100)).at(-1)!.includes("(off)"));
  assert.equal(instance.getText(), "多行\n草稿");
  assert.equal(h.factory, factory);
});

test("existing native-layout editor factories keep their own input shortcuts and ownership", () => {
  let opens = 0;
  class BrowserLikeEditor extends CustomEditor {
    handleInput(data: string) {
      if (data === "\x1b[D" && !this.getText() && !this.isShowingAutocomplete()) { opens++; return; }
      super.handleInput(data);
    }
  }
  const previous = (tui: any, theme: any, keys: any) => new BrowserLikeEditor(tui, theme, keys);
  const h = harness("quiet", previous);
  h.emit("session_start");
  const decorated = h.current;
  assert.ok(decorated instanceof BrowserLikeEditor);
  decorated.handleInput("\x1b[D");
  assert.equal(opens, 1);
  assert.match(plain(decorated.render(80))[0]!, /^╭/);
  const factory = h.factory;
  h.emit("session_start");
  assert.equal(h.factory, factory);
  h.emit("session_shutdown");
  assert.equal(h.factory, previous);
  assert.equal(decorated.render, Editor.prototype.render);
  assert.equal(h.notices.length, 0);
  // Even a later extension retaining our former factory cannot resurrect it.
  const stale = factory(h.tui, theme, keys);
  assert.equal(stale.render, Editor.prototype.render);
});

test("incompatible custom renderers are untouched and visibly reported", () => {
  const custom = { render: (_width: number) => ["custom"], getText: () => "", setText() {}, handleInput() {} };
  const h = harness("quiet", () => custom);
  h.emit("session_start");
  assert.equal(h.current, custom);
  assert.deepEqual(h.current.render(80), ["custom"]);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0]!, /skipped/);
  const locked = editor();
  Object.defineProperty(locked, "render", { configurable: false, value: Editor.prototype.render });
  assert.equal(decorateQuietEditor(locked, metadata), undefined);
});

test("shutdown/reload never clobbers a later factory or renderer", () => {
  const h = harness();
  h.emit("session_start");
  const instance = h.current;
  const savedRender = instance.render;
  const laterRender = (width: number) => savedRender.call(instance,width);
  instance.render = laterRender;
  const laterFactory = () => instance;
  h.ctx.ui.setEditorComponent(laterFactory);
  h.emit("session_start");
  assert.equal(h.factory, laterFactory, "don't take the slot back on repeated starts");
  h.emit("session_shutdown");
  assert.equal(h.factory, laterFactory);
  assert.equal(instance.render, laterRender);
  assert.ok(!plain(instance.render(80))[0]!.startsWith("╭"), "captured wrappers become native after disposal");
  // Simulate Pi's reload reset BEFORE shutdown, followed by a fresh runtime.
  const reloaded = harness();
  reloaded.emit("session_start");
  reloaded.ctx.ui.setEditorComponent(undefined);
  reloaded.emit("session_shutdown");
  assert.equal(reloaded.factory, undefined);
  const next = harness();
  next.emit("session_start");
  assert.equal(plain(next.current.render(80)).filter((line) => line.startsWith("╭")).length, 1);
});
