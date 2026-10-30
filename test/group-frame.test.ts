/**
 * The grouping end to end on pi's real components: ToolExecutionComponent with
 * pi's own bash/edit definitions, AssistantMessageComponent, and clicks
 * dispatched through pi-tui's Container.handleMouse with screen rows — the same
 * path a terminal click takes.
 *
 * Runs in its own process (node --test isolates files), so the options set
 * here do not leak into the box-rendering tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssistantMessageComponent,
  CustomMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../frame.ts";
import { resetGroups, THOUGHT_LIVE_MS } from "../tool-groups.ts";
import { tidyEnabled, agentRunning } from "../live.ts";
import { connectJobs, resetJobs, type EventBusLike } from "../background-jobs.ts";

initTheme("dark");
const renderUserUnpatched = UserMessageComponent.prototype.render;
const renderCustomUnpatched = CustomMessageComponent.prototype.render;
const OPTIONS = { icons: false, groupTools: true } as const;
patchToolBoxFrames(OPTIONS);

let renders = 0;
const ui = { requestRender: () => renders++ };
const cwd = process.cwd();
const bashDef = createBashToolDefinition(cwd);
const editDef = createEditToolDefinition(cwd);
const W = 90;

/** `expanded` is private in pi's typings; the tests read it as pi's state. */
type Box = { expanded: boolean } & Pick<ToolExecutionComponent, "render" | "invalidate" | "setExpanded">;

let nextId = 0;
const callBlock = (id: string, name = "bash") => ({ type: "toolCall", id, name, arguments: {} });

/** A finished bash call, built the way pi builds one. */
function bash(command: string, output: string, extra: { isError?: boolean; partial?: boolean } = {}) {
  const id = `call-${++nextId}`;
  const c = new ToolExecutionComponent("bash", id, { command }, {}, bashDef as any, ui as any, cwd);
  c.setExpanded(false);
  c.setArgsComplete();
  c.markExecutionStarted();
  if (!extra.partial) {
    c.updateResult(
      { content: [{ type: "text", text: output }], isError: extra.isError ?? false, durationMs: 150 } as any,
      false,
    );
  }
  return { id, component: c as unknown as Box };
}

function edit(path: string) {
  const id = `call-${++nextId}`;
  const c = new ToolExecutionComponent("edit", id, { path, edits: [{ oldText: "a", newText: "b" }] }, {}, editDef as any, ui as any, cwd);
  c.setExpanded(false);
  c.setArgsComplete();
  c.markExecutionStarted();
  c.updateResult(
    {
      content: [{ type: "text", text: "ok" }],
      isError: false,
      durationMs: 20,
      details: { diff: "-1 const a = 1;\n+1 const a = 2;", firstChangedLine: 1 },
    } as any,
    false,
  );
  return { id, component: c as unknown as Box };
}

const text = (t: string) => new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop" } as any);
/** A model step with text that also calls `id`. */
const textStep = (t: string, id: string, name = "bash") =>
  new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: t }, callBlock(id, name)], stopReason: "toolUse" } as any);
/** A tool-only model step (thinking hidden, as in `hideThinkingBlock: true`). */
const step = (id: string, name = "bash") =>
  new AssistantMessageComponent(
    { role: "assistant", content: [{ type: "thinking", thinking: "…" }, callBlock(id, name)], stopReason: "toolUse" } as any,
    true,
  );

/** A tool-only model step that carries `thinking` (pi's own setting hides it). */
const thinkStep = (id: string, thinking: string) =>
  new AssistantMessageComponent(
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking },
        callBlock(id),
      ],
      stopReason: "toolUse",
    } as any,
    true,
  );

const strip = (s: string) => s.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|_[^\x07]*\x07)/g, "").trimEnd();

/** Render until the patch stops asking pi for another frame. */
function frame(chat: Container): string[] {
  let lines: string[] = [];
  for (let i = 0; i < 5; i++) {
    const before = renders;
    lines = chat.render(W);
    if (renders === before) break;
  }
  // Metrics are right-aligned now; the assertions read the content, not the padding.
  return lines.map(strip).map((line) => line.replace(/ {2,}/g, "  "));
}

/** Click the first row containing `needle`, the way pi-tui dispatches it. */
function click(chat: Container, needle: string, x = 4): unknown {
  const lines = frame(chat);
  const y = lines.findIndex((line) => line.includes(needle));
  assert.ok(y >= 0, `no row containing ${JSON.stringify(needle)}:\n${lines.join("\n")}`);
  const event = { type: "click", button: "left", x, y, screenX: x, screenY: y, width: W, height: lines.length, shift: false, alt: false, ctrl: false };
  return chat.handleMouse(event as any);
}

function threeBash() {
  const chat = new Container();
  const a = bash("ls", "a\nb");
  const b = bash("pwd", "/tmp");
  const c = bash("whoami", "andy");
  chat.addChild(textStep("Checking.", a.id));
  chat.addChild(a.component);
  chat.addChild(step(b.id));
  chat.addChild(b.component);
  chat.addChild(step(c.id));
  chat.addChild(c.component);
  chat.addChild(text("Done."));
  return { chat, a, b, c };
}

const visible = (lines: string[]) => lines.filter((line) => line.trim());

test("three bash calls across three model steps render as one C line", () => {
  const { chat } = threeBash();
  assert.deepEqual(visible(frame(chat)), [" Checking.", " ▸ 3 calls · bash×3 · 2 thoughts · 0.5s", " Done."]);
});

test("C → ▾ + rows → one box → back to its row → ▾ folds back to C", () => {
  const { chat, b } = threeBash();
  assert.ok(click(chat, "3 calls"));
  assert.deepEqual(visible(frame(chat)), [
    " Checking.",
    " ▾ 3 calls · bash×3 · 2 thoughts · 0.5s",
    " │ ✓ bash ls  2 lines · 0.2s",
    " │ thinking  …",
    " │ ✓ bash pwd  1 line · 0.2s",
    " │ thinking  …",
    " │ ✓ bash whoami  1 line · 0.2s",
    " Done.",
  ]);

  assert.ok(click(chat, "bash pwd"));
  assert.equal(b.component.expanded, true);
  const opened = frame(chat);
  // Inside the group there is no box: the rail already frames it. The row keeps
  // its place and takes a tick, and its output hangs under it.
  assert.ok(!opened.some((line) => line.includes("╭")), opened.join("\n"));
  assert.ok(opened.includes(" ├─ ✓ bash pwd  1 line · 0.2s"), opened.join("\n"));
  // The body hangs under the row, one indent in (the harness collapses runs of
  // spaces, so this is the collapsed form).
  assert.ok(opened.some((line) => line.startsWith(" │  ") && line.includes("/tmp")), opened.join("\n"));

  // A click inside the body goes through pi's own MouseRegion — translated
  // into the body's coordinates — and folds just that box.
  assert.ok(click(chat, "/tmp", 6));
  assert.equal(b.component.expanded, false);
  assert.ok(frame(chat).includes(" │ ✓ bash pwd  1 line · 0.2s"));

  assert.ok(click(chat, "▾ 3 calls"));
  assert.deepEqual(visible(frame(chat)), [" Checking.", " ▸ 3 calls · bash×3 · 2 thoughts · 0.5s", " Done."]);
});

test("folding from ▾ folds the open boxes too, so reopening shows plain rows", () => {
  const { chat, a, c } = threeBash();
  click(chat, "3 calls");
  click(chat, "bash ls");
  click(chat, "bash whoami");
  assert.equal(a.component.expanded && c.component.expanded, true);
  click(chat, "▾ 3 calls");
  assert.equal(a.component.expanded || c.component.expanded, false);
  click(chat, "3 calls");
  assert.equal(frame(chat).filter((line) => line.includes("╭")).length, 0);
});

test("a failed call folds away: the header carries it, the row waits in level 1", () => {
  const chat = new Container();
  const a = bash("ls", "a");
  const b = bash("pnpm test", "boom\n\nCommand exited with code 1", { isError: true });
  chat.addChild(textStep("Testing.", a.id));
  chat.addChild(a.component);
  chat.addChild(step(b.id));
  chat.addChild(b.component);
  // One line, folded: two failures hanging under a 56-call group is the thing
  // that made folding pointless.
  assert.deepEqual(visible(frame(chat)), [" Testing.", " ▸ 2 calls · bash×2 · 1 thought · 1 failed · 0.3s"]);
  assert.ok(click(chat, "2 calls"), "the header opens the group");
  assert.ok(frame(chat).some((line) => line.includes("✗ bash pnpm test")), "the row is there now");
  assert.ok(click(chat, "pnpm test"));
  assert.equal(b.component.expanded, true);
  assert.ok(frame(chat).some((line) => line.includes("boom")));
});

test("a running call gets its row under the folded header after a second", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const chat = new Container();
  const a = bash("ls", "a");
  const b = bash("sleep 30", "", { partial: true });
  chat.addChild(textStep("Waiting.", a.id));
  chat.addChild(a.component);
  chat.addChild(step(b.id));
  chat.addChild(b.component);
  assert.deepEqual(visible(frame(chat)), [" Waiting.", " ▸ 2 calls · bash×2 · 1 thought · 0.2s"], "no flicker for quick calls");
  t.mock.timers.tick(1000);
  const lines = visible(frame(chat));
  assert.equal(lines[1], " ▸ 2 calls · bash×2 · 1 thought · running bash");
  assert.equal(lines[2], " │ ⋯ bash sleep 30");
});

test("a step streaming its thinking folds with the group mid-segment, not at a turn's start", () => {
  const thinkingStep = () => {
    const c = new AssistantMessageComponent(
      { role: "assistant", content: [{ type: "thinking", thinking: "…" }], stopReason: "toolUse" } as any,
      true,
    );
    c.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: "…" }] } as any, true);
    return c;
  };
  const mid = new Container();
  const a = bash("ls", "a");
  mid.addChild(textStep("Go.", a.id));
  mid.addChild(a.component);
  mid.addChild(thinkingStep());
  assert.ok(!frame(mid).some((line) => line.includes("Thinking...")), "no flash under the summary");

  const start = new Container();
  start.addChild(new UserMessageComponent("hi"));
  start.addChild(thinkingStep());
  // At the turn's start there is no group to fold into, so the run stands alone —
  // as the same row it wears everywhere else, not as pi's bare label.
  const alone = frame(start);
  assert.ok(!alone.some((line) => line.includes("Thinking...")), alone.join("\n"));
  assert.ok(alone.some((line) => line.includes("thinking  …")), "a sign of life before any call");
});

test("edit keeps pi's own box, splits the group, and its box takes clicks", () => {
  const chat = new Container();
  const a = bash("ls", "a");
  const e = edit("/tmp/x.ts");
  const b = bash("pnpm test", "ok");
  chat.addChild(textStep("Editing.", a.id));
  chat.addChild(a.component);
  chat.addChild(step(e.id, "edit"));
  chat.addChild(e.component);
  chat.addChild(step(b.id));
  chat.addChild(b.component);
  const lines = frame(chat);
  assert.ok(lines.includes(" ▸ 1 call · bash×1 · 1 thought · 0.2s"));
  assert.ok(lines.some((line) => line.includes("↳ diff")), "the summary stays visible");
  assert.ok(!lines.some((line) => line.includes("const a = 2;")), "collapsed now means summary-only");
  assert.equal(lines.filter((line) => line.includes("1 call")).length, 2, "calls after the edit start a new group");

  // edit renders with renderShell "self"; pi's handler for those reads a height
  // only its own render records, so before 0.4.0 these clicks were dropped.
  assert.ok(click(chat, "/tmp/x.ts", 2));
  assert.equal(e.component.expanded, true);
  assert.ok(frame(chat).some((line) => line.includes("const a = 2;")));
});

test("ctrl+o expands every box and folds back to the C line", () => {
  const { chat } = threeBash();
  frame(chat);
  for (const child of chat.children) (child as any).setExpanded?.(true);
  // No boxes inside a group — three ticks and three hanging bodies.
  assert.equal(frame(chat).filter((line) => line.includes("├─")).length, 3);
  for (const child of chat.children) (child as any).setExpanded?.(false);
  assert.deepEqual(visible(frame(chat)), [" Checking.", " ▸ 3 calls · bash×3 · 2 thoughts · 0.5s", " Done."]);
});

test("presses, right clicks and drags are not taken as clicks", () => {
  const { chat, a } = threeBash();
  const lines = frame(chat);
  const y = lines.findIndex((line) => line.includes("3 calls"));
  for (const event of [
    { type: "press", button: "left" },
    { type: "click", button: "right" },
    { type: "drag", button: "left" },
  ]) {
    const result = chat.handleMouse({ ...event, x: 4, y, screenX: 4, screenY: y, width: W, height: lines.length } as any);
    assert.equal(result, undefined, event.type);
  }
  assert.equal(a.component.expanded, false);
  assert.ok(frame(chat).includes(" ▸ 3 calls · bash×3 · 2 thoughts · 0.5s"));
});

test("options are live: a re-patch (what /reload does) and enabled=false take effect", () => {
  const { chat } = threeBash();
  assert.ok(frame(chat).includes(" ▸ 3 calls · bash×3 · 2 thoughts · 0.5s"));

  patchToolBoxFrames({ ...OPTIONS, groupTools: false });
  try {
    const lines = frame(chat);
    assert.equal(lines.filter((line) => line.includes("╭")).length, 3, "every call is a box again");
    assert.ok(!lines.some((line) => line.includes("calls")));
    assert.ok(lines.some((line) => line.includes("Thinking...")), "carriers render as pi draws them");

    tidyEnabled.set(false);
    assert.equal(frame(chat).filter((line) => line.includes("╭")).length, 0, "pi's own unframed boxes");
  } finally {
    tidyEnabled.set(true);
    patchToolBoxFrames(OPTIONS);
  }
  assert.ok(frame(chat).includes(" ▸ 3 calls · bash×3 · 2 thoughts · 0.5s"));
});

test("grouping preserves user-message padding and prompt markers verbatim", () => {
  for (const width of [24, W]) {
    for (const prompt of ["hi", "请列出当前目录中的文件，并检查它们的内容。\n保留消息之间的空行。"]) {
      const user = new UserMessageComponent(prompt);
      const expected = renderUserUnpatched.call(user, width);
      assert.equal(strip(expected[expected.length - 1]), "", "pi supplies bottom padding");
      assert.deepEqual(user.render(width), expected, `user rendering at width ${width}`);
    }
  }
});

test("a custom message keeps its own padding while grouping", () => {
  // pi pads a custom message with a Spacer above and `Box(1, 1, customMessageBg)`
  // below — the same shape as a user message, so the same trim used to eat it.
  const noticeLines = new CustomMessageComponent({
    role: "custom",
    customType: "notice",
    content: "pay attention",
    display: true,
    timestamp: 0,
  } as any);
  const expected = renderCustomUnpatched.call(noticeLines, W);
  assert.equal(strip(expected[expected.length - 1]), "", "pi supplies bottom padding");
  assert.deepEqual(noticeLines.render(W), expected, "custom message rendering is untouched");

  const chat = new Container();
  const a = bash("ls", "a\nb");
  chat.addChild(noticeLines);
  chat.addChild(step(a.id));
  chat.addChild(a.component);
  const lines = frame(chat);
  const body = lines.findIndex((line) => line.includes("pay attention"));
  const header = lines.findIndex((line) => line.includes("▸ 1 call"));
  assert.ok(body >= 0 && header >= 0, lines.join("\n"));
  assert.equal(header, body + 2, "one blank row separates the notice and group");
  assert.equal(lines[header - 1], "");
});

test("user padding separates a folded group without shifting its click targets", () => {
  const chat = new Container();
  const a = bash("ls", "a\nb");
  const b = bash("pwd", "/tmp");
  chat.addChild(new UserMessageComponent("List files."));
  chat.addChild(step(a.id));
  chat.addChild(a.component);
  chat.addChild(step(b.id));
  chat.addChild(b.component);
  chat.addChild(text("Done."));

  const lines = frame(chat);
  const prompt = lines.findIndex((line) => line.includes("List files."));
  const header = lines.findIndex((line) => line.includes("▸ 2 calls"));
  assert.ok(prompt >= 0 && header >= 0, lines.join("\n"));
  assert.equal(header, prompt + 2, "one blank row separates the prompt and group");
  assert.equal(lines[header - 1], "");
  assert.ok(click(chat, "2 calls"));
  assert.ok(click(chat, "bash pwd"));
  assert.equal(b.component.expanded, true);
  assert.ok(click(chat, "▾ 2 calls"));
  assert.equal(b.component.expanded, false);
  assert.deepEqual(frame(chat), lines, "folding restores the same spacing");
});

test("user-message boundary survives a predecessor-skipping render patch on top", () => {
  // pi-starline replaces UserMessageComponent.prototype.render and only calls
  // the predecessor as a fallback. It loads after toolbox, so it lands on top.
  const proto = UserMessageComponent.prototype as any;
  const previous = proto.render;
  const userLines = ["\x1b]133;A\x07", "> user", "\x1b[48;2;40;40;40m    \x1b[0m\x1b]133;B\x07"];
  proto.render = function () {
    return userLines;
  };
  try {
    const chat = new Container();
    const a = bash("ls", "a");
    const b = bash("pwd", "/tmp");
    // Turn 1 ends with a tool; turn 2 starts with a tool-only step.
    chat.addChild(textStep("Go.", a.id));
    chat.addChild(a.component);
    const user = new UserMessageComponent("next");
    chat.addChild(user);
    chat.addChild(step(b.id));
    chat.addChild(b.component);
    assert.deepEqual(visible(frame(chat)), [" Go.", " ▸ 1 call · bash×1 · 0.2s", "> user", " ▸ 1 call · bash×1 · 1 thought · 0.2s"]);
    assert.deepEqual(user.render(W), userLines, "the replacement renderer keeps its padding and markers");
  } finally {
    proto.render = previous;
  }
});

test("thinking is a row above its own call, and clicking it opens pi's text", () => {
  const chat = new Container();
  const a = bash("ls", "a");
  const b = bash("pwd", "/tmp");
  // Long enough that the collapsed row has to truncate it.
  const first =
    "先确认一下这个目录里有什么东西，然后再决定下一步怎么做，最后把结论写进结尾标记里。这一段故意写得很长，用来验证预览行真的会截断。";
  chat.addChild(textStep("Checking.", a.id));
  chat.addChild(thinkStep(a.id, first));
  chat.addChild(a.component);
  chat.addChild(thinkStep(b.id, "再看工作目录是不是仓库根。"));
  chat.addChild(b.component);

  // Folded: the count is the only trace of the thinking (pi itself would print
  // nothing here — `hideThinkingBlock` is on for both steps).
  assert.deepEqual(visible(frame(chat)), [" Checking.", " ▸ 2 calls · bash×2 · 2 thoughts · 0.3s"]);

  assert.ok(click(chat, "2 calls"));
  const open = frame(chat).filter((line) => line.trim());
  assert.equal(open.length, 6, open.join("\n"));
  assert.equal(open[0], " Checking.");
  assert.equal(open[1], " ▾ 2 calls · bash×2 · 2 thoughts · 0.3s");
  // The preview row: the label, then the whole run cut to the row width.
  assert.ok(open[2].startsWith(" │ thinking  先确认一下这个目录"), open[2]);
  assert.ok(open[2].endsWith("…"), `the preview is cut to the row width: ${open[2]}`);
  assert.equal(open[3], " │ ✓ bash ls  1 line · 0.2s");
  assert.equal(open[4], " │ thinking  再看工作目录是不是仓库根。");
  assert.equal(open[5], " │ ✓ bash pwd  1 line · 0.2s");

  // A click on the row expands that step's thinking: pi renders its own text,
  // untruncated, inside the same rounded box a tool result gets.
  const y = frame(chat).findIndex((line) => line.includes("先确认一下这个目录"));
  assert.ok(y >= 0);
  chat.handleMouse({ type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width: W, height: 10 } as any);
  const opened = frame(chat);
  assert.ok(
    opened.some((line) => line.includes("结尾标记")),
    `the whole run is shown, not a preview:\n${opened.join("\n")}`,
  );
  assert.ok(
    !opened.some((line) => line.includes("╭")),
    `inside the group the rail frames it, no box:\n${opened.join("\n")}`,
  );
  // The step that owns the summary line was the one expanded: the line stays.
  assert.equal(opened.filter((line) => line.trim())[1], " ▾ 2 calls · bash×2 · 2 thoughts · 0.3s");
  // Its neighbour keeps its own row: expansion is per step.
  assert.ok(opened.some((line) => line.includes("再看工作目录是不是仓库根。")));

  // Clicking it again folds it back — the row comes back, the box goes.
  chat.handleMouse({ type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width: W, height: 10 } as any);
  const closed = frame(chat);
  assert.ok(!closed.some((line) => line.includes("╭")), closed.join("\n"));
  assert.ok(closed.some((line) => line.startsWith(" │ thinking  先确认一下这个目录")));
});

test("an expanded run does not take the group header's click", () => {
  const chat = new Container();
  const a = bash("ls", "a");
  const first =
    "先确认一下这个目录里有什么东西，然后再决定下一步怎么做，最后把结论写进结尾标记里。这一段故意写得很长，用来验证预览行真的会截断。";
  chat.addChild(textStep("Checking.", a.id));
  chat.addChild(thinkStep(a.id, first));
  chat.addChild(a.component);
  chat.addChild(text("Done."));
  assert.ok(click(chat, "1 call"));

  // The step that owns the summary line is also the one whose run is open.
  assert.ok(click(chat, "先确认一下这个目录"));
  assert.ok(frame(chat).some((line) => line.includes("结尾标记")), "the run is open");

  // The header keeps its own click: this closes the group rather than folding
  // the run that happens to sit next to it.
  assert.ok(click(chat, "1 call"));
  assert.deepEqual(visible(frame(chat)), [" Checking.", " ▸ 1 call · bash×1 · 1 thought · 0.2s", " Done."]);
});

test("a step that is still thinking spins instead of keeping a still brain", () => {
  const chat = new Container();
  const a = bash("ls", "a");
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "还在想。" },
      { type: "toolCall", id: a.id, name: "bash", arguments: {} },
    ],
    stopReason: "toolUse",
  };
  const streaming = new AssistantMessageComponent(message as any, true);
  streaming.updateContent(message as any, true);
  // The call of step 1 is done; step 2 is still thinking, so it renders last.
  chat.addChild(textStep("Checking.", a.id));
  chat.addChild(a.component);
  chat.addChild(streaming);

  agentRunning.set(true);
  try {
    const folded = visible(frame(chat))[1] as string;
    // While it is thinking the entry says so; the count comes back when it stops.
    assert.match(folded, /[◐◓◑◒] thinking/, `the summary spins while the step streams: ${folded}`);
    // Folded, the live run keeps one sliding row under it; the row itself does not
    // animate — the frame set belongs to the summary line.
    assert.ok(click(chat, "thinking"));
    const shown = frame(chat);
    // The frame set lives on the summary, never on a row: no spinner after the rail.
    assert.ok(!shown.some((line) => new RegExp("^\\s*│\\s*[◐◓◑◒]").test(line)), shown.join("\n"));

    // Settled: the summary keeps the brain, the row stays (the group is open).
    streaming.updateContent(message as any, false);
    const settled = frame(chat);
    assert.ok(!settled.some((line) => /[◐◓◑◒]/.test(line)), settled.join("\n"));
    assert.ok(settled.some((line) => line.includes("thinking  还在想。")));
  } finally {
    agentRunning.set(false);
  }
});

test("thinking outside a group is live too: the row slides and spins, then settles", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  resetGroups();
  const chat = new Container();
  const run = "先读一遍目录树，确认哪些文件是这一轮要改的，再看看测试里有没有覆盖到那段结尾标记，最后决定动不动手";
  const message = { role: "assistant", content: [{ type: "thinking", thinking: run }] };
  const streaming = new AssistantMessageComponent(undefined, true);
  streaming.updateContent(message as any, true);
  chat.addChild(streaming);
  agentRunning.set(true);
  try {
    const live = visible(frame(chat));
    assert.equal(live.length, 1, `one row, and no group line (nothing was called):\n${live.join("\n")}`);
    assert.match(live[0], /[◐◓◑◒] thinking/, `outside a group the row carries the spinner: ${live[0]}`);
    assert.ok(live[0].includes("结尾标记"), `the newest words own the row: ${live[0]}`);
    assert.ok(!live[0].includes("先读一遍"), `the head has scrolled out: ${live[0]}`);

    // No new token: it goes quiet on its own, the way a row inside a group does.
    t.mock.timers.tick(THOUGHT_LIVE_MS);
    const settled = visible(frame(chat));
    assert.ok(!/[◐◓◑◒]/.test(settled.join("\n")), settled.join("\n"));
    assert.ok(settled[0].includes("先读一遍"), `settled, the head is what you glance at: ${settled[0]}`);
  } finally {
    agentRunning.set(false);
  }
});

test("a message that both thinks and writes wears the same row, but the group does not count it", () => {  const chat = new Container();
  const a = bash("ls", "a");
  // thinking + text + a call: the text makes this message the group *boundary*,
  // so its thinking is pi's own label — which is what used to float above the
  // text as a bare `Thinking...`.
  chat.addChild(
    new AssistantMessageComponent(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先想一下要列哪些。" },
          { type: "text", text: "列一下目录。" },
          { type: "toolCall", id: a.id, name: "bash", arguments: {} },
        ],
        stopReason: "toolUse",
      } as any,
      true,
    ),
  );
  chat.addChild(a.component);
  const lines = visible(frame(chat));
  assert.ok(!lines.some((line) => line.includes("Thinking...")), lines.join("\n"));
  assert.ok(
    lines.some((line) => line.includes("thinking  先想一下要列哪些。")),
    `the label became a row:\n${lines.join("\n")}`,
  );
  // The boundary renders its run itself, above the text. The group lists only
  // the runs of the steps it folded, so a count here would name a row that
  // opening the group cannot show.
  assert.ok(
    lines.some((line) => line.includes("1 call · bash×1")),
    `the group stays a call count:\n${lines.join("\n")}`,
  );
  assert.ok(!lines.some((line) => line.includes("thought")), `the boundary's run is not in the count:\n${lines.join("\n")}`);

  // And it opens into the same box a tool result gets, right where it sits —
  // then the box folds back into the row.
  const y = frame(chat).findIndex((line) => line.includes("thinking  先想一下"));
  assert.ok(y >= 0);
  chat.handleMouse({ type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width: W, height: 10 } as any);
  const boxed = frame(chat);
  assert.ok(boxed.some((line) => line.includes("╭")), boxed.join("\n"));
  // The title stays above the box — outside a group the box is the only frame,
  // so it has to say what it holds.
  assert.ok(
    boxed.some((line) => line.includes("thinking  先想一下")),
    `the title sits above its box:\n${boxed.join("\n")}`,
  );
  const boxTop = boxed.findIndex((line) => line.includes("╭"));
  chat.handleMouse({ type: "click", button: "left", x: 4, y: boxTop, screenX: 4, screenY: boxTop, width: W, height: 10 } as any);
  const folded = frame(chat);
  assert.ok(!folded.some((line) => line.includes("╭")), folded.join("\n"));
  assert.ok(folded.some((line) => line.includes("thinking  先想一下要列哪些。")));
});

test("a step that did not think keeps its call in the block, with no gap of its own", () => {
  const chat = new Container();
  const a = bash("ls", "a");
  const b = bash("pwd", "/tmp");
  const c = bash("whoami", "andy");
  chat.addChild(textStep("Checking.", a.id));
  chat.addChild(a.component);
  // Step 2 thought, then step 3 called a tool without thinking at all.
  chat.addChild(thinkStep(b.id, "看一下目录。"));
  chat.addChild(b.component);
  chat.addChild(
    new AssistantMessageComponent(
      { role: "assistant", content: [{ type: "toolCall", id: c.id, name: "bash", arguments: {} }], stopReason: "toolUse" } as any,
      true,
    ),
  );
  chat.addChild(c.component);

  assert.ok(click(chat, "3 calls"));
  assert.deepEqual(
    visible(frame(chat)),
    [
      " Checking.",
      " ▾ 3 calls · bash×3 · 1 thought · 0.5s",
      " │ ✓ bash ls  1 line · 0.2s",
      " │ thinking  看一下目录。",
      " │ ✓ bash pwd  1 line · 0.2s",
      " │ ✓ bash whoami  1 line · 0.2s",
    ],
    frame(chat).join("\n"),
  );
});

test("a thinking-only message toggles on any click, and a thinking+text one on its row", () => {
  for (const [label, content] of [
    ["thinking only", [{ type: "thinking", thinking: "想一下。" }]],
    ["thinking + text", [{ type: "thinking", thinking: "想一下。" }, { type: "text", text: "说一句。" }]],
  ] as const) {
    const chat = new Container();
    chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [...content] as any[], stopReason: "stop" } as any, true));
    assert.ok(frame(chat).some((line) => line.includes("thinking  想一下。")), label);
    // Row 0 is the thinking row in both shapes: pi's padding rows are trimmed.
    chat.handleMouse({ type: "click", button: "left", x: 3, y: 0, screenX: 3, screenY: 0, width: W, height: 10 } as any);
    assert.ok(frame(chat).some((line) => line.includes("╭")), `${label}: opens its box`);
    // And back: the box is the click target that folds it.
    chat.handleMouse({ type: "click", button: "left", x: 3, y: 1, screenX: 3, screenY: 1, width: W, height: 10 } as any);
    assert.ok(!frame(chat).some((line) => line.includes("╭")), `${label}: folds back`);
  }
});

/**
 * The click handler a carrier installs lives on the component, and a component's
 * role changes under it: an assistant step streams as a carrier, then its text
 * arrives and it becomes the group boundary. The handler used to answer "row"
 * to every `y`, so once a step had been through the carrier path, every click on
 * that message — the code block included — opened its thinking instead of
 * reaching the text.
 */
test("a step that streamed as a carrier hands clicks back once its text arrives", () => {
  resetGroups();
  const chat = new Container();
  const a = bash("ls", "a");
  chat.addChild(a.component);
  const step = new AssistantMessageComponent(undefined, true);
  chat.addChild(step);
  const run = "先想一下目录里有什么。";
  agentRunning.set(true);
  try {
    // Streaming, with the group's first call already placed: this is the carrier
    // path, which is what installs the row handler, and its row is on screen.
    step.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: run }] } as any, true);
    assert.ok(
      visible(frame(chat)).some((line) => line.includes("thinking  先想一下")),
      frame(chat).join("\n"),
    );
    // The row opens where it sits, then folds back from a click on itself.
    assert.ok(click(chat, "thinking  先想一下"));
    assert.ok(
      visible(frame(chat)).some((line) => line.includes("├─") && line.includes("thinking")),
      `the row takes a tick and hangs its reasoning under it:\n${frame(chat).join("\n")}`,
    );
    assert.ok(click(chat, "├─"));
  } finally {
    agentRunning.set(false);
  }

  // The text arrives: the same component is now the boundary that owns it.
  step.updateContent(
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: run },
        { type: "text", text: "查了 API。\n\n```fish\ncurl -s https://example.com | jq -r '.end'\n```\n" },
      ],
      stopReason: "stop",
    } as any,
    false,
  );
  const lines = visible(frame(chat));
  const codeRow = lines.findIndex((line) => line.includes("curl -s"));
  assert.ok(codeRow >= 0, lines.join("\n"));
  chat.handleMouse({ type: "click", button: "left", x: 4, y: codeRow, screenX: 4, screenY: codeRow, width: W, height: 20 } as any);
  assert.ok(
    !frame(chat).some((line) => line.includes("├─") || line.includes("╭")),
    `a click in the text must not open the thinking:\n${frame(chat).join("\n")}`,
  );

  // Its own row still opens and folds, exactly as before.
  assert.ok(click(chat, "thinking  先想一下"));
  assert.ok(frame(chat).some((line) => line.includes("╭")), `the row still opens:\n${frame(chat).join("\n")}`);
  assert.ok(click(chat, "╭"));
  assert.ok(!frame(chat).some((line) => line.includes("╭")), frame(chat).join("\n"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Background jobs (pi-processes protocol, on a stand-in event bus)
// ─────────────────────────────────────────────────────────────────────────────
/** pi's extension bus with pi-processes answering `processes:request:get`. */
function processesBus(known: Record<string, object>) {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const b: EventBusLike = {
    emit(channel, data) {
      for (const handler of listeners.get(channel) ?? []) handler(data);
    },
    on(channel, handler) {
      listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
      return () => {};
    },
  };
  b.on("processes:request:get", (payload) => {
    const { id, reply } = payload as { id: string; reply(info: unknown): void };
    reply(known[id] ?? null);
  });
  return b;
}

const procInfo = (id: string, extra: object = {}) => ({
  id,
  name: id,
  pid: 1,
  command: "x",
  cwd: "/tmp",
  startTime: Date.now() - 12_000,
  endTime: null,
  status: "running",
  exitCode: null,
  success: null,
  endReason: null,
  signal: null,
  errorMessage: null,
  ...extra,
});

/** A `process start` call the way pi-processes returns it (no renderer: pi's fallback box). */
function processStart(name: string) {
  const id = `call-${++nextId}`;
  const c = new ToolExecutionComponent("process", id, { action: "start", name, command: "x" }, {}, undefined, ui as any, cwd);
  c.setExpanded(false);
  c.setArgsComplete();
  c.markExecutionStarted();
  c.updateResult(
    {
      content: [{ type: "text", text: `Started process ${name}` }],
      isError: false,
      durationMs: 5,
      details: { action: "start", process: procInfo(name), notify: {} },
    } as any,
    false,
  );
  return { id, component: c as unknown as Box };
}

const notice = (processId: string, kind: string, extra: object = {}) =>
  new CustomMessageComponent({
    role: "custom",
    customType: "ad-process:notification",
    content: `[process] "${processId}" ${kind}`,
    display: true,
    details: { kind, processId, processName: processId, command: "x", timestamp: Date.now(), summary: "", attention: "turn", ...extra },
    timestamp: Date.now(),
  } as any);

test("a running job keeps a spinning row under the folded header", () => {
  resetJobs();
  const b = processesBus({ ticker: procInfo("ticker") });
  connectJobs(b);
  const chat = new Container();
  const start = processStart("ticker");
  const ls = bash("ls", "a");
  chat.addChild(textStep("Starting.", start.id, "process"));
  chat.addChild(start.component);
  chat.addChild(step(ls.id));
  chat.addChild(ls.component);
  const lines = visible(frame(chat));
  assert.match(lines[1], /^ ▸ 2 calls · bash×1 {2}process×1 · 1 thought · [◐◓◑◒] 1 running · /);
  assert.match(lines[2], /^ │ [◐◓◑◒] process ticker {2}running 1[23]s$/);

  // The job ends: the row changes in place, and the ended job folds away.
  b.emit("processes:ended", procInfo("ticker", { status: "exited", success: true, exitCode: 0, endTime: Date.now() }));
  const after = visible(frame(chat));
  assert.equal(after.length, 2, "nothing left to show while folded");
  assert.doesNotMatch(after[1], /running/);
  click(chat, "2 calls");
  assert.ok(frame(chat).some((line) => /│ ✓ process ticker {2}exited 0 · 1[23]s/.test(line)));
});

test("a job's notifications are hidden once its row exists; strangers stay", () => {
  resetJobs();
  connectJobs(processesBus({ ticker: procInfo("ticker") }));
  const chat = new Container();
  const start = processStart("ticker");
  chat.addChild(textStep("Starting.", start.id, "process"));
  chat.addChild(start.component);
  chat.addChild(notice("ticker", "log_match", { logMatch: { pattern: "READY" } }));
  chat.addChild(notice("someone-else", "success"));
  chat.addChild(text("Got READY."));
  const lines = frame(chat);
  assert.ok(!lines.some((line) => line.includes('"ticker"')), "ticker's notice is folded into its row");
  assert.ok(lines.some((line) => line.includes('"someone-else"')), "a job with no row keeps its notice");
  assert.ok(lines.some((line) => /process ticker {2}running \d+s · READY matched/.test(line)), "the row carries what it said");
});

test("a reloaded session: jobs pi-processes doesn't know are rebuilt from their notifications", () => {
  resetJobs();
  connectJobs(processesBus({})); // a fresh pi: the manager knows nothing
  const chat = new Container();
  const ticker = processStart("ticker");
  const lost = processStart("lost");
  chat.addChild(textStep("Starting.", ticker.id, "process"));
  chat.addChild(ticker.component);
  chat.addChild(step(lost.id, "process"));
  chat.addChild(lost.component);
  chat.addChild(notice("ticker", "killed", { signal: { name: "SIGTERM" } }));
  click(chat, "2 calls");
  const lines = frame(chat);
  assert.ok(lines.some((line) => /│ ⊘ process ticker {2}killed SIGTERM/.test(line)), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("│ ⊘ process lost  not running")));
  assert.ok(!lines.some((line) => /[◐◓◑◒]/.test(line)), "nothing spins");
});
