import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { FooterComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { registerCompactFooter, renderCompactFooter, workspaceIdentity, type CompactFooterInfo } from "../compact-footer.ts";

initTheme("dark");
const theme = (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")];
const dim = (text: string) => theme.fg("dim", text);
const plain = (text: string) => stripTerminalSequences(text);
function info(overrides: Partial<CompactFooterInfo> = {}): CompactFooterInfo {
  return { cwd: join(tmpdir(), "workspace"), branch: null, session: "会话", statuses: new Map(), dim, ...overrides };
}

// Compare the actual public native component's identity, including dim styling.
// The test-only stats stub avoids constructing a real agent session.
function nativeIdentity(current: CompactFooterInfo, width: number): string {
  const session = { state: {}, sessionManager: { getCwd: () => current.cwd, getSessionName: () => current.session } };
  const data = { getGitBranch: () => current.branch, getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1 };
  const footer = new FooterComponent(session as any, data as any);
  Reflect.set(footer, "getSessionStats", () => ({ usageTotals: {}, contextUsage: undefined }));
  return footer.render(width)[0]!;
}

test("workspace/session uses native Pi path, branch, separator, dim and unnamed-session styling", () => {
  const home = process.env.HOME || process.env.USERPROFILE;
  const root = home || tmpdir();
  for (const current of [
    info({ cwd: root, home, session: undefined }),
    info({ cwd: join(root, "workspace"), home, branch: "main", session: "中文 👩‍💻" }),
    info({ cwd: root + "-sibling", home, session: "session" }),
  ]) {
    assert.equal(renderCompactFooter(current, 2000)[0], nativeIdentity(current, 2000));
    assert.equal(renderCompactFooter(current, 18)[0], nativeIdentity(current, 18));
  }
  const current = info({ home: join(tmpdir(), "home"), cwd: join(tmpdir(), "home", "project"), branch: "main", session: "name" });
  assert.match(workspaceIdentity(current), /^~[/\\]project \(main\) • name$/);
  assert.ok(!workspaceIdentity(info({ session: undefined })).includes("•"));
});

test("quota and every other extension status share the native identity row, without stats or model", () => {
  const quota = "5h 21% ↻34m · 1w 60% ↻5d";
  const current = info({ statuses: new Map([
    ["mcp", "mcp ready"], ["subscription-usage", `\x1b[32m${quota}\x1b[39m`], ["side-chat", "btw busy"],
  ]) });
  const lines = renderCompactFooter(current, 240);
  assert.equal(lines.length, 1);
  const text = plain(lines[0]!);
  assert.ok(text.startsWith(workspaceIdentity(current)));
  assert.ok(text.includes(quota));
  assert.match(text, /mcp ready.*btw busy/);
  assert.ok(text.indexOf(quota) < text.indexOf("mcp ready"));
  assert.ok(lines[0]!.includes("\x1b[32m"), "extension quota colors survive");
  assert.ok(!/CH|\$|tokens|thinking|no-model/.test(text));
  assert.equal(visibleWidth(lines[0]!), 240);
});

test("one row stays width-safe for CJK, emoji, ANSI, multiline statuses and resize", () => {
  const current = info({
    cwd: join(tmpdir(), "工作区👩‍💻".repeat(10)), session: "长会话 e\u0301".repeat(20) + "\x1b[2J\n",
    statuses: new Map([["subscription-usage", "\x1b[31m5h 21%\x1b[39m\n1w\t60%\r👩‍💻\x1b[2J"], ["other", "状态 e\u0301".repeat(20)]]),
  });
  for (const width of [0,1,2,3,4,7,8,9,12,20,30,60,120,300,40,140]) {
    const lines = renderCompactFooter(current, width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]!) <= width, `width ${width}: ${JSON.stringify(lines)}`);
    assert.ok(!/[\r\n\t]/.test(lines[0]!));
    assert.ok(!lines[0]!.includes("\x1b[2J"));
  }
  assert.ok(plain(renderCompactFooter(current, 30)[0]!).includes("5h"), "quota has priority over other statuses when narrow");
});

test("empty, loading, auth-error and removed quota states use the supplied status text", () => {
  const statuses = new Map<string, string>();
  const current = info({ statuses });
  assert.equal(plain(renderCompactFooter(current, 100)[0]!), workspaceIdentity(current));
  for (const text of ["usage …", "usage auth ?", "usage error", "5h 30% · 1w 65%"] ) {
    statuses.set("subscription-usage", text);
    assert.ok(plain(renderCompactFooter(current, 120)[0]!).includes(text));
  }
  statuses.set("mcp", "mcp auth");
  statuses.delete("subscription-usage");
  assert.ok(!plain(renderCompactFooter(current, 120)[0]!).includes("usage"));
  assert.ok(plain(renderCompactFooter(current, 120)[0]!).includes("mcp auth"));
});

function harness(style: "native" | "quiet" = "quiet") {
  const handlers = new Map<string, Function[]>();
  const statuses = new Map<string, string>();
  const branchListeners = new Set<() => void>();
  const calls: any[] = [];
  const notices: string[] = [];
  let current: any;
  let factory: any;
  let session = "Old session";
  let branch: string | null = "main";
  let unsubscribes = 0;
  const tui = { renders: 0, requestRender() { this.renders++; } };
  const data = {
    getGitBranch: () => branch,
    getExtensionStatuses: () => statuses,
    onBranchChange(fn: () => void) { branchListeners.add(fn); return () => { unsubscribes++; branchListeners.delete(fn); }; },
  };
  const ctx = {
    hasUI: true, mode: "tui", cwd: join(tmpdir(), "workspace"),
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: (message: string) => notices.push(message),
      setFooter(value: any) {
        calls.push(value);
        current?.dispose?.();
        factory = value;
        current = value?.(tui, ctx.ui.theme, data);
      },
    },
    getContextUsage() { throw new Error("footer must not scan session usage"); },
  } as any;
  const pi = {
    on: (event: string, fn: Function) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    getSessionName: () => session,
  } as any;
  registerCompactFooter(pi, style);
  return {
    ctx,pi,handlers,calls,notices,tui,statuses,branchListeners,
    emit(event: string, context = ctx) { handlers.get(event)?.forEach((fn) => fn({}, context)); },
    get current() { return current; }, get factory() { return factory; }, get unsubscribes() { return unsubscribes; },
    setName(value: string) { session = value; },
    setBranch(value: string | null) { branch = value; branchListeners.forEach((fn) => fn()); },
  };
}

test("live quota map, native identity, name, branch and theme update without recreating the footer", () => {
  const h = harness();
  h.emit("session_start");
  const component = h.current;
  const render = () => plain(component.render(180)[0]);
  assert.match(render(), /workspace \(main\) • Old session/);
  h.statuses.set("subscription-usage", "5h 20% · 1w 60%");
  assert.match(render(), /5h 20% · 1w 60%/);
  h.statuses.set("subscription-usage", "5h 22% · 1w 61%");
  assert.match(render(), /5h 22% · 1w 61%/);
  h.setName("New session");
  h.emit("session_info_changed");
  h.setBranch("changed");
  assert.match(render(), /workspace \(changed\) • New session/);
  assert.equal(h.tui.renders, 2);
  h.ctx.ui.theme = { fg: (_color: string, text: string) => `\x1b[35m${text}\x1b[39m` };
  assert.ok(component.render(180)[0].includes("\x1b[35m"));
  const next = { ...h.ctx, cwd: join(tmpdir(), "other-workspace") };
  h.emit("session_start", next);
  assert.match(render(), /other-workspace/);
  assert.equal(h.current, component);
  assert.equal(h.calls.length, 1);
});

test("native style, non-TUI and absent public API do not replace the footer", () => {
  const native = harness("native");
  assert.equal(native.handlers.size, 0);
  for (const mode of ["rpc", "print", "json"]) {
    const h = harness();
    h.ctx.mode = mode;
    h.ctx.ui.setFooter = () => { throw new Error("must not change non-TUI footer"); };
    h.emit("session_start");
    assert.equal(h.calls.length, 0);
  }
  const h = harness();
  delete h.ctx.ui.setFooter;
  h.emit("session_start");
  assert.equal(h.notices.length, 1);
  assert.equal(h.calls.length, 0);
});

test("shutdown restores builtin only while owned, and disposes branch subscriptions once", () => {
  const h = harness();
  h.emit("session_start");
  const component = h.current;
  const stale = h.factory;
  h.emit("session_shutdown");
  assert.equal(h.factory, undefined);
  assert.equal(h.calls.length, 2);
  assert.equal(h.branchListeners.size, 0);
  assert.equal(h.unsubscribes, 1);
  component.dispose();
  h.emit("session_shutdown");
  assert.equal(h.calls.length, 2);
  assert.equal(h.unsubscribes, 1);
  assert.deepEqual(component.render(80), []);
  const recreated = stale(h.tui, {}, {});
  assert.deepEqual(recreated.render(80), []);
  assert.equal(h.branchListeners.size, 0);
});

test("later footer owners and Pi's pre-shutdown reload reset are never overwritten", () => {
  const h = harness();
  h.emit("session_start");
  const later = () => ({ render: () => ["later footer"], invalidate() {} });
  h.ctx.ui.setFooter(later);
  assert.equal(h.branchListeners.size, 0);
  h.emit("session_start");
  h.emit("session_shutdown");
  assert.equal(h.factory, later);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.current.render(80), ["later footer"]);

  const reload = harness();
  reload.emit("session_start");
  reload.ctx.ui.setFooter(undefined);
  reload.emit("session_shutdown");
  assert.equal(reload.calls.length, 2);
  assert.equal(reload.factory, undefined);
  reload.emit("session_start");
  assert.equal(reload.current.render(80).length, 1);
  assert.equal(reload.branchListeners.size, 1);
});
