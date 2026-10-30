/** Per-owner diff layouts must survive alternating historical edit boxes. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";
import { createSplitDiffRenderer, type SplitDiffInput } from "../split-diff.ts";
import { patchToolBoxFrames } from "../frame.ts";
import { getTheme } from "../theme-access.ts";

initTheme("dark");
const options = { icons: false, groupTools: false, backgroundJobs: false, diffLines: 20 } as const;
patchToolBoxFrames(options);
const DIFF = "-1 const oldValue = 1;\n+1 const newValue = 2;";
const input = (): SplitDiffInput => ({ diff: DIFF, width: 100, theme: getTheme()!, filePath: "sample.ts", maxLines: 20 });

test("independent diff renderers retain each owner's last layout", () => {
  const a = createSplitDiffRenderer();
  const b = createSplitDiffRenderer();
  const first = input();
  const second = { ...input(), diff: DIFF.replaceAll("Value", "Other") };
  const expectedA = a(first);
  const expectedB = b(second);
  assert.ok(expectedA);
  assert.ok(expectedB);
  for (let i = 0; i < 5; i++) {
    assert.equal(a({ ...first }), expectedA);
    assert.equal(b({ ...second }), expectedB);
  }
});

test("all semantic diff inputs invalidate the single retained layout", () => {
  const render = createSplitDiffRenderer();
  const value = input();
  let previous = render(value);
  const next = (change: Partial<SplitDiffInput>) => {
    Object.assign(value, change); // Caller mutation must not mutate the cache key.
    const actual = render(value);
    assert.ok(actual);
    assert.notEqual(actual, previous);
    assert.equal(render({ ...value }), actual);
    previous = actual;
  };
  next({ diff: DIFF.replace("= 2", "= 3") });
  next({ width: 120 });
  next({ filePath: "sample.py" });
  next({ maxLines: 0 });
  next({ maxLines: undefined });
  next({ theme: { fg: (color, text) => getTheme()!.fg(color, text), bg: (color, text) => getTheme()!.bg!(color, text), bold: (text) => text } });
  assert.equal(render({ ...value, width: 20 }), null, "narrow fallback is cached too");
  assert.equal(render({ ...value, width: 20 }), null);
  assert.ok(render(value));
});

let nextId = 0;
function edit(diff = DIFF) {
  const component = new ToolExecutionComponent("edit", `cache-${++nextId}`, { path: "sample.ts" }, {}, undefined, { requestRender() {} } as any, process.cwd()) as any;
  component.setExpanded(false);
  component.updateResult({ content: [{ type: "text", text: "fallback body" }], isError: false }, false);
  let label = "edit sample.ts";
  const call = Object.assign(new Box(0, 0), { preview: { diff } });
  call.addChild({ render: () => [label], invalidate() {} });
  component.callRendererComponent = call;
  return { component, call, setLabel: (text: string) => { label = text; } };
}

test("real edit boxes reuse bodies across frames but refresh call labels and invalidations", () => {
  const theme = getTheme()!;
  const original = theme.fg;
  const descriptor = Object.getOwnPropertyDescriptor(theme, "fg");
  let builds = 0;
  let recolor = false;
  theme.fg = function (color, text) {
    if (color === "toolDiffAdded") builds++;
    if (recolor && color === "toolDiffRemoved") return `\x1b[38;2;255;0;255m${text}\x1b[39m`;
    return original.call(this, color, text);
  };
  try {
    const a = edit();
    const b = edit(DIFF.replaceAll("Value", "Other"));
    const before = a.component.render(120);
    b.component.render(120);
    const warm = builds;
    assert.ok(warm > 0, "palette construction records expensive body builds");
    for (let i = 0; i < 5; i++) {
      assert.equal(a.component.render(120), before, "the outer frame is reusable too");
      b.component.render(120);
    }
    assert.equal(builds, warm, "alternating boxes do not evict each other");
    a.setLabel("edit renamed-label.ts");
    assert.ok(a.component.render(120).some((line: string) => line.includes("renamed-label.ts")));
    assert.equal(builds, warm, "call row stays live without rebuilding the diff");

    const rebuild = (change: () => void) => {
      const count = builds;
      change();
      a.component.render(120);
      assert.ok(builds > count, "changed inputs rebuild the body");
    };
    rebuild(() => { a.call.preview.diff = DIFF.replace("= 2", "= 4"); });
    rebuild(() => { a.component.args.path = "sample.py"; });
    rebuild(() => { a.component.setExpanded(true); });
    rebuild(() => { a.component.setExpanded(false); });
    rebuild(() => { patchToolBoxFrames({ ...options, diffLines: 0 }); });
    patchToolBoxFrames(options);
    a.component.render(120);
    const count = builds;
    a.component.render(100);
    assert.ok(builds > count, "resize rebuilds");
    a.component.render(120);
    const oldColors = a.component.render(120);
    recolor = true; // Same theme object, as with an in-place theme refresh.
    rebuild(() => a.component.invalidate());
    const refreshed = a.component.render(120) as string[];
    assert.notDeepEqual(refreshed, oldColors);
    assert.ok(refreshed.some((line) => line.includes("\x1b[38;2;255;0;255m")));
  } finally {
    patchToolBoxFrames(options);
    if (descriptor) Object.defineProperty(theme, "fg", descriptor);
    else delete (theme as any).fg;
  }
});

test("missing and errored previews still fall back to Pi's body", () => {
  const { component, call } = edit();
  assert.ok(component.render(120).some((line: string) => line.includes("oldValue")));
  call.preview = { error: "not available" } as any;
  assert.ok(component.render(120).some((line: string) => line.includes("fallback body")));
  delete component.callRendererComponent;
  assert.ok(component.render(120).some((line: string) => line.includes("fallback body")));
});
