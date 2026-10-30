/** Regression coverage for thinking layout without alternating Markdown widths. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, MouseRegion } from "@earendil-works/pi-tui";
import { patchToolBoxFrames } from "../frame.ts";
import { resetGroups } from "../tool-groups.ts";

initTheme("dark");
const proto = AssistantMessageComponent.prototype as any;
const originalRender = proto.render;
let predecessor: ((component: any, args: any[], render: () => string[]) => string[]) | undefined;
// Stand in for another extension below Tidy, including its failure path.
proto.render = function (...args: any[]) {
  const render = () => originalRender.apply(this, args);
  return predecessor ? predecessor(this, args, render) : render();
};
patchToolBoxFrames({ icons: false, groupTools: true, backgroundJobs: false });

const thinking = (thinking: string) => ({ type: "thinking", thinking });
const text = (text: string) => ({ type: "text", text });
function message(content: object[], shown: number[] = [], hide = true): any {
  resetGroups();
  const value = { role: "assistant", content, stopReason: "stop" };
  const component = new AssistantMessageComponent(value as any, hide) as any;
  for (const run of shown) component.thinkingVisibilityOverrides.set(run, false);
  if (shown.length) component.updateContent(value);
  return component;
}
const regions = (component: any): any[] => component.contentContainer.children.filter((kid: any) => kid instanceof MouseRegion);
const plain = (line: string) => line.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, "");
const markers = (lines: string[]) => lines.join("").match(/\x1b\]133;[ABC]\x07/g) ?? [];
function track(child: any) {
  const calls: Array<{ width: number; hit: boolean }> = [];
  const render = child.render;
  child.render = function (width: number) {
    calls.push({ width, hit: !!this.cachedLines && this.cachedWidth === width && this.cachedText === this.text });
    return render.call(this, width);
  };
  return calls;
}
const click = (component: any, y: number, width = 100) => component.handleMouse({
  type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width, height: 100,
});

test("expanded thinking renders once at its final width and stays warm after resizing", () => {
  const component = message([thinking("First **reasoning** paragraph."), text("Normal **response**."), thinking("Second reasoning.")], [0, 1]);
  const runs = regions(component);
  assert.ok(runs.every((run) => run.child instanceof Markdown));
  const calls = runs.map((run) => track(run.child));
  const normal = component.contentContainer.children.find((kid: any) => kid instanceof Markdown);
  const normalCalls = track(normal);
  const descriptors = runs.map((run) => Object.getOwnPropertyDescriptor(run, "render"));
  for (const width of [120, 120, 120, 100, 100]) {
    const lines = component.render(width);
    assert.ok(lines.some((line: string) => line.includes("Normal")), "ordinary response survives");
    for (let i = 0; i < runs.length; i++) assert.deepEqual(Object.getOwnPropertyDescriptor(runs[i], "render"), descriptors[i]);
  }
  for (const actual of calls) {
    assert.deepEqual(actual.map((call) => call.width), [118, 118, 118, 98, 98]);
    assert.deepEqual(actual.map((call) => call.hit), [false, true, true, false, true]);
  }
  assert.ok(normalCalls.every((call) => call.width === 120 || call.width === 100));
  assert.equal(normalCalls.filter((call) => !call.hit).length, 2, "ordinary Markdown also stays warm");
});

test("folded thinking does not render the hidden body, even when Pi starts expanded", () => {
  const component = message([thinking("Long private reasoning body."), text("Visible response.")], [], false);
  const run = regions(component)[0];
  assert.ok(run.child instanceof Markdown);
  const calls = track(run.child);
  for (let i = 0; i < 3; i++) component.render(120);
  assert.equal(calls.length, 0);
  assert.equal(component.thinkingVisibilityOverrides.get(0), true);
  assert.equal(Object.hasOwn(run, "render"), false, "temporary adapter does not leak");
});

test("restyling preserves OSC 133 markers exactly once, including a final thinking child", () => {
  for (const content of [
    [thinking("Only reasoning.")],
    [text("Response first."), thinking("Reasoning last.")],
    [thinking("Reasoning first."), text("Response last.")],
    [thinking("First run."), text("Middle response."), thinking("Second run.")],
    [thinking("Reasoning."), text("Response."), { type: "toolCall", id: "marker-call", name: "bash", arguments: {} }],
  ]) {
    for (const expanded of [false, true]) {
      const component = message(content);
      if (expanded) {
        regions(component).forEach((_, i) => component.thinkingVisibilityOverrides.set(i, false));
        component.updateContent(component.lastMessage);
      }
      const expected = markers(originalRender.call(component, 120));
      assert.deepEqual(markers(component.render(120)), expected);
      assert.deepEqual(markers(component.render(100)), expected);
    }
  }
});

test("thinking adapters restore inherited and own renderers on success and failure", () => {
  const component = message([thinking("First run."), text("Middle response."), thinking("Second run.")], [0, 1]);
  const runs = regions(component);
  Object.defineProperty(runs[0], "render", { value: runs[0].render, writable: true, configurable: true, enumerable: false });
  const descriptors = runs.map((run) => Object.getOwnPropertyDescriptor(run, "render"));
  const failure = new Error("predecessor render failed");
  predecessor = (self, args, render) => {
    assert.equal(self, component);
    assert.deepEqual(args, [120, "extra argument"]);
    render();
    throw failure;
  };
  try {
    assert.throws(() => component.render(120, "extra argument"), (error) => error === failure);
  } finally {
    predecessor = undefined;
  }
  for (let i = 0; i < runs.length; i++) assert.deepEqual(Object.getOwnPropertyDescriptor(runs[i], "render"), descriptors[i]);
  component.render(120);
  for (let i = 0; i < runs.length; i++) assert.deepEqual(Object.getOwnPropertyDescriptor(runs[i], "render"), descriptors[i]);
});

test("unpatchable child renderers fall back to the predecessor unchanged", () => {
  const component = message([thinking("Reasoning."), text("Response.")], [0]);
  const run = regions(component)[0];
  Object.defineProperty(run, "render", { value: run.render, configurable: false });
  const expected = originalRender.call(component, 120).map(plain).filter((line: string) => line.trim());
  assert.deepEqual(component.render(120).map(plain).filter((line: string) => line.trim()), expected);
});

test("resized thinking boxes toggle only their own run and leave adjacent text alone", () => {
  const component = message([thinking("FIRST_RUN"), text("Ordinary response."), thinking("SECOND_RUN")], [0, 1]);
  component.render(120);
  let lines = component.render(100).map(plain) as string[];
  const normalY = lines.findIndex((line) => line.includes("Ordinary response"));
  click(component, normalY);
  assert.deepEqual([...component.thinkingVisibilityOverrides.values()], [false, false]);
  const secondY = lines.findIndex((line) => line.includes("SECOND_RUN"));
  assert.ok(click(component, secondY + 1), "second box border folds the second run");
  assert.deepEqual([...component.thinkingVisibilityOverrides.values()], [false, true]);
  lines = component.render(100).map(plain);
  assert.ok(click(component, lines.findIndex((line) => line.includes("SECOND_RUN"))), "second title reopens it");
  assert.deepEqual([...component.thinkingVisibilityOverrides.values()], [false, false]);
  lines = component.render(100).map(plain);
  assert.ok(click(component, lines.findIndex((line) => line.includes("FIRST_RUN")) + 1));
  assert.deepEqual([...component.thinkingVisibilityOverrides.values()], [true, false]);
});

test("updated thinking and theme invalidation rebuild the displayed body", () => {
  const component = message([thinking("Old reasoning."), text("Response.")], [0]);
  const before = component.render(120);
  component.updateContent({ role: "assistant", content: [thinking("New reasoning."), text("Response.")], stopReason: "stop" });
  const updated = component.render(120) as string[];
  assert.ok(updated.some((line) => line.includes("New reasoning")));
  assert.ok(!updated.some((line) => line.includes("Old reasoning")));
  initTheme("light");
  try {
    component.invalidate();
    assert.notDeepEqual(component.render(120), before);
    assert.notDeepEqual(component.render(120), updated);
  } finally {
    initTheme("dark");
  }
});
