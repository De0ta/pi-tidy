/**
 * How a tool box looks and reacts while it belongs to a group (tool-groups.ts
 * owns the state; this file turns a `ViewPlan` into lines and clicks):
 *
 *    ▸ 3 calls ·  bash×3 · 1 failed · 0.5s     header, carried by the first member
 *    │ ⋯ bash  pnpm test                      a row (only a running call shows while folded)
 *    │ ╭──────────────╮                       a full box, three cells in
 *
 * Also installs the boundary hooks on the message components, which is where
 * the groups get cut.
 */

import { stripVTControlCharacters } from "node:util";
import { MouseRegion, truncateToWidth, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, CustomMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
  ANIMATE_MS, closeJobDetails, jobDetails, jobForTool, jobsForTool, noteJobMessage,
  spinnerFrame, toggleJobDetails, type JobDetails, type JobState,
} from "./background-jobs.ts";
import { padToWidth } from "./frame-draw.ts";
import { getTheme, type ThemeLike } from "./theme-access.ts";
import { drawFrame, trimBlankEdges } from "./frame-draw.ts";
import {
  formatGroupLine,
  formatThoughtLine,
  formatToolLine,
  formatJobLine,
  GUTTER_CELLS,
  groupGutter,
  formatDuration,
  previewText,
  summarizeResult,
  THOUGHT_LABEL_CELLS,
  THOUGHT_TICK_MS,
} from "./tool-lines.ts";
import {
  carrierPlan,
  classifyAssistant,
  closeGroup,
  currentGroupHasMembers,
  groupMembers,
  groupIsOpen,
  RUNNING_ROW_DELAY_MS,
  noteBoundary,
  noteThinking,
  thinkingState,
  openGroup,
  planFor,
  summaryFor,
  takeLateJoin,
  thinkingRuns,
  toolCallIds,
  type ViewPlan,
} from "./tool-groups.ts";

/** The slice of ToolExecutionComponent the group view reads. */
export interface GroupedTool {
  toolName: string;
  toolCallId?: string;
  args?: unknown;
  isPartial: boolean;
  expanded: boolean;
  result?: { isError?: boolean; durationMs?: number; content?: unknown; details?: unknown };
  imageComponents?: unknown[];
  ui?: { requestRender?(): void };
  setExpanded(expanded: boolean): void;
}

/**
 * Cells a grouped full box is shifted right by: the gutter plus a space. Boxes
 * with images skip the gutter — their lines carry graphics payloads that must
 * start at the left edge.
 */
function boxIndent(tool: GroupedTool, plan: ViewPlan): number {
  return plan.gutter && !(tool.imageComponents?.length ?? 0) ? GUTTER_CELLS + 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hover
//
// `move` packets (1003 all-motion tracking, which pi enables outside tmux) are
// routed to the component under the pointer even with no button down, so a
// folded row can react to the pointer without a click. The row handler never
// consumes the event: pi still gets it for text selection, and the repaint is
// requested directly.
// ─────────────────────────────────────────────────────────────────────────────

type HoverRow = "header" | "row" | `job:${string}`;

/**
 * `ui` is kept as the object, not its `requestRender`: pi's TUI is a class, so
 * an extracted method would lose `this`.
 */
type Renderer = { requestRender?(): void };
let hoverState: { tool: object | null; row: HoverRow | null; ui?: Renderer } = { tool: null, row: null };
/** Set by a row that wants this packet; the alt-screen wrapper clears otherwise. */
let hoverClaimed = false;
/** Only tracked once the clear hook is in place — a stale band is worse than none. */
let hoverTracking = false;

/** Next render pass: which row of which tool the pointer is on, if any. */
function setHover(tool: object | null, row: HoverRow | null, ui?: Renderer): boolean {
  if (hoverState.tool === tool && hoverState.row === row) {
    if (ui) hoverState.ui = ui;
    return false;
  }
  hoverState = { tool, row, ui: ui ?? hoverState.ui };
  return true;
}

/** The pointer left our rows (or the app): drop the band and repaint it away. */
function clearHover(): void {
  if (!hoverState.tool) return;
  hoverState = { tool: null, row: null, ui: hoverState.ui };
  hoverState.ui?.requestRender?.();
}

/** A full-width band behind the row: the whole row is the click target. */
function hoverBand(line: string, width: number, theme: ThemeLike): string {
  const padded = padToWidth(line, width);
  return theme.bg ? theme.bg("selectedBg", padded) : padded;
}

const HOVER_HOOK = Symbol.for("pi-toolbox:hover-hook");

/**
 * Every mouse packet goes through the alt screen. Watching it is what makes
 * hover honest: a pointer that moves off our rows — onto the editor, a message,
 * the scrollbar — produces no event for us at all, so without this hook the
 * last row would stay lit forever. No hook, no hover.
 */
export function installHoverTracking(): void {
  const proto = (TuiAltScreen as unknown as { prototype?: Record<PropertyKey, any> })?.prototype;
  if (!proto || proto[HOVER_HOOK]) return;
  const original = proto.handleMouseEvent;
  if (typeof original !== "function") return;
  proto.handleMouseEvent = function (this: unknown, raw: unknown) {
    hoverClaimed = false;
    const result = original.call(this, raw);
    if (!hoverClaimed) clearHover();
    return result;
  };
  proto[HOVER_HOOK] = true;
  hoverTracking = true;
}

/** Test seam: pretend the packets are being watched. */
export function enableHoverForTests(): void {
  hoverTracking = true;
}

/** Test seam: pretend nothing is watching the packets. */
export function disableHoverForTests(): void {
  hoverTracking = false;
}

/** Test seam: forget what is hovered. */
export function resetHover(): void {
  hoverState = { tool: null, row: null };
  hoverClaimed = false;
}

/**
 * The tool's lines while grouping is on, or `undefined` when it is an
 * always-shown tool and should render as a plain box.
 */
export function renderGroupedTool(
  tool: GroupedTool,
  width: number,
  theme: ThemeLike,
  options: { icons: boolean; pinned: boolean },
  frameBox: (width: number, unframed?: boolean) => string[],
): string[] | undefined {
  // Another extension may have patched a boundary render on top of ours
  // since; re-wrap so the boundaries keep being seen.
  installGroupBoundaries();
  nestedRowSpans.delete(tool);
  const job = options.pinned ? undefined : jobForTool(tool);
  const jobs = options.pinned ? [] : jobsForTool(tool);
  if (tool.ui) lastUi = tool.ui;
  const now = Date.now();
  const plan = planFor(tool, options.pinned, runningJob(jobs) ?? job, now);
  if (takeLateJoin()) tool.ui?.requestRender?.();
  if (plan.revealIn !== undefined) scheduleReveal(tool, plan.revealIn);
  if (!plan.header && !plan.gutter) return undefined;

  const { icons } = options;
  const lines: string[] = [];
  const hovered = hoverState.tool === tool ? hoverState.row : null;
  if (plan.header) {
    const line = groupHeaderLine(tool, plan.header, theme, width, icons, hovered === "header", now);
    if (line !== undefined) lines.push(line);
  }
  const gutter = groupGutter(theme);
  if (plan.line || plan.full) {
    const spinner = job ? spinnerFrame(job) : undefined;
    // The tick costs two cells more than the rail does.
    const rowWidth = width - GUTTER_CELLS - (plan.full ? 2 : 0);
    const row = formatToolLine(tool, theme, { icons, job, spinner, hovered: hovered === "row", width: rowWidth, align: groupAlign(tool) });
    // An opened call keeps its row — it does not turn into something else — and
    // takes a tick off the rail to show what hangs below it.
    const line = plan.full ? `${tickGutter(theme)} ${row.trimStart()}` : gutter + row;
    lines.push(hovered === "row" ? hoverBand(line, width, theme) : truncateToWidth(line, width, "…"));
  }
  if (plan.full) {
    // Inside the group the rail already says what belongs to what, so a box
    // would be a frame inside a frame. Only the body is drawn, hanging under
    // the row that opened it.
    const body = frameBox(Math.max(4, width - BODY_INDENT), true);
    for (const line of body) lines.push(`${gutter}${BODY_PAD}${line.replace(/\s+$/, "")}`);
  }
  // Nested starts belong to the wrapper, but do not replace its result/error.
  // Keep them below its body so the body's existing click geometry is unchanged.
  const spans: NestedRowSpan[] = [];
  const open = groupIsOpen(tool);
  for (const nested of jobs) {
    if (nested === job) continue;
    const details = jobDetails(nested.id);
    if (!open && !details && (nested.status !== "running" || now - (nested.startTime ?? now) < RUNNING_ROW_DELAY_MS)) continue;
    const from = lines.length;
    const hot = hovered === `job:${nested.id}`;
    const arrow = details ? "▾" : hot ? "▶" : "▸";
    const row = formatJobLine({ toolName: "process", isPartial: false }, nested, theme, icons, spinnerFrame(nested, now));
    const line = `${gutter}  ${theme.fg("muted", arrow)}${row}`;
    lines.push(hot ? hoverBand(line, width, theme) : truncateToWidth(line, width, "…"));
    if (details) {
      for (const body of renderJobDetails(nested, details, theme)) {
        lines.push(truncateToWidth(`${gutter}      ${body}`, width, "…"));
      }
    }
    spans.push({ id: nested.id, from, to: lines.length - 1 });
  }
  nestedRowSpans.set(tool, spans);
  return lines;
}

interface NestedRowSpan { id: string; from: number; to: number }
const nestedRowSpans = new WeakMap<object, NestedRowSpan[]>();

/** Logs are plain text here: no cursor moves, OSC payloads, tabs or embedded rows. */
function jobText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function renderJobDetails(job: JobState, details: JobDetails, theme: ThemeLike): string[] {
  const lines = [theme.fg("muted", `id: ${jobText(job.id)}`)];
  if (details.command) lines.push(theme.fg("toolOutput", `$ ${jobText(details.command)}`));
  if (details.cwd) lines.push(theme.fg("muted", `cwd: ${jobText(details.cwd)}`));
  if (!details.logs) lines.push(theme.fg("muted", "Logs unavailable."));
  else if (details.logs.length === 0) lines.push(theme.fg("muted", "No output yet."));
  else for (const entry of details.logs) {
    lines.push(theme.fg(entry.type === "stderr" ? "error" : "toolOutput", `${entry.type}: ${jobText(entry.text)}`));
  }
  return lines;
}

function closeGroupJobDetails(component: object): void {
  for (const member of groupMembers(component)) closeJobDetails(jobsForTool(member as GroupedTool).map((job) => job.id));
}

function runningJob(jobs: JobState[]): JobState | undefined {
  return jobs.filter((job) => job.status === "running").sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity))[0];
}

/**
 * The note and duration columns for a group: the widest of each, so every row
 * pads to the same width and the metrics line up down the block. Recomputed
 * when the group's membership changes, not per row — `summarizeResult` walks a
 * result's whole output, and doing that once per row would be quadratic.
 */
const alignCache = new WeakMap<readonly object[], { count: number; note: number; duration: number }>();

function groupAlign(anchor: object): { note: number; duration: number } {
  const members = groupMembers(anchor);
  const cached = alignCache.get(members);
  if (cached && cached.count === members.length) return cached;
  let note = 0;
  let duration = 0;
  for (const member of members) {
    note = Math.max(note, visibleWidth(summarizeResult(member.toolName, member.result)));
    duration = Math.max(duration, visibleWidth(formatDuration(member.result?.durationMs ?? 0)));
  }
  const entry = { count: members.length, note, duration };
  alignCache.set(members, entry);
  return entry;
}

/**
 * The rail with a tick: `├─`. Used by an opened call's row, whose output hangs
 * below it — the horizontal line is what points at the row the block belongs to.
 */
function tickGutter(theme: ThemeLike): string {
  return ` ${theme.fg("borderMuted", "├─")}`;
}

/** Cells an opened call's body is pushed in by, under its row: the rail plus three. */
const BODY_INDENT = GUTTER_CELLS + 3;
const BODY_PAD = "   ";

/**
 * The group's summary line. Carried by the first member — or by a leading
 * carrier, which renders before that member does (see `carrierPlan`).
 */
function groupHeaderLine(
  anchor: object,
  header: "closed" | "open",
  theme: ThemeLike,
  width: number,
  icons: boolean,
  hovered: boolean,
  now: number,
): string | undefined {
  const jobs: JobState[] = [];
  const summary = summaryFor(
    anchor,
    (member) => {
      const owned = jobsForTool(member as GroupedTool);
      jobs.push(...owned);
      return owned;
    },
    now,
  );
  if (!summary) return undefined;
  const line = formatGroupLine(summary, theme, {
    icons,
    open: header === "open",
    // One spinner for the row: a running job, or a thought still arriving.
    spinner: summary.thinking ? thinkingSpinner(now) : groupSpinner(jobs),
    thinkingColor: thinkingColorFor(),
    hovered,
  });
  return hovered ? hoverBand(line, width, theme) : truncateToWidth(line, width, "…");
}

/** A quarter-turn frame that follows the wall clock, so any repaint advances it. */
function thinkingSpinner(now: number): string {
  return spinnerFrame({ id: "", name: "", status: "running", startTime: now }, now);
}

const revealScheduled = new WeakSet<object>();

/**
 * A running row hidden for its first second must appear on time even if
 * nothing else repaints (a quiet tool, or a background job's first second).
 */
function scheduleReveal(tool: GroupedTool, ms: number): void {
  if (revealScheduled.has(tool)) return;
  revealScheduled.add(tool);
  const timer = setTimeout(() => {
    revealScheduled.delete(tool);
    tool.ui?.requestRender?.();
  }, Math.max(0, ms) + 20);
  timer.unref?.();
}

/**
 * The repaint that takes a stalled thinking row (and its spinner) off screen.
 * Nothing else will ask for it: the run is quiet and pi is idle by then.
 */
const settleScheduled = new WeakSet<object>();

function scheduleSettle(component: object, ms: number): void {
  if (settleScheduled.has(component)) return;
  settleScheduled.add(component);
  const timer = setTimeout(() => {
    settleScheduled.delete(component);
    lastUi?.requestRender?.();
  }, Math.max(0, ms) + 20);
  timer.unref?.();
}

/** The header's glyph: spinning while any running job is young, then still. */
function groupSpinner(jobs: JobState[]): string {
  const now = Date.now();
  const running = jobs.filter((job) => job.status === "running");
  const young = running.some((job) => job.startTime === undefined || now - job.startTime < ANIMATE_MS);
  return young ? spinnerFrame({ id: "", name: "", status: "running", startTime: now }, now) : "●";
}

/** Which of this tool's clickable rows sits at `y`, if any. */
function hoverRowAt(plan: ViewPlan, y: number | undefined): HoverRow | null {
  if (typeof y !== "number") return null;
  if (plan.header && y === 0) return "header";
  const row = plan.header ? y - 1 : y;
  return plan.line && row === 0 ? "row" : null;
}

/** `routeGroupedMouse` result meaning "not grouped: handle it as a plain box". */
export const NOT_GROUPED = Symbol("not grouped");

export interface MouseRouting {
  pinned: boolean;
  /** Run `fn` as pointer-driven (pi's box toggle must not read as ctrl+o). */
  asPointer<T>(fn: () => T): T;
  /** Hand the event to the full box, shifted by the gutter and header. */
  boxMouse(event: any, dx: number, dy: number): unknown;
}

/**
 * Clicks on a grouped tool. Only left clicks on our own rows are taken —
 * presses and drags fall through so text selection keeps working.
 */
export function routeGroupedMouse(tool: GroupedTool, event: any, routing: MouseRouting): unknown {
  const job = routing.pinned ? undefined : jobForTool(tool);
  const jobs = routing.pinned ? [] : jobsForTool(tool);
  const plan = planFor(tool, routing.pinned, runningJob(jobs) ?? job);
  if (!plan.header && !plan.gutter) return NOT_GROUPED;

  // pi-tui names buttons ("left"); accept the raw SGR code too.
  const click = event?.type === "click" && (event.button === "left" || event.button === 0);
  let y = event?.y;
  const nested = typeof y === "number" ? nestedRowSpans.get(tool)?.find((span) => y >= span.from && y <= span.to) : undefined;
  if (nested) {
    if (event?.type === "move" && hoverTracking) {
      const row: HoverRow | null = y === nested.from ? `job:${nested.id}` : null;
      if (row) hoverClaimed = true;
      if (setHover(row ? tool : null, row, tool.ui)) tool.ui?.requestRender?.();
    }
    if (click && y === nested.from) {
      toggleJobDetails(nested.id);
      setHover(null, null);
      tool.ui?.requestRender?.();
      return { handled: true };
    }
    // The log body is selectable text, not the enclosing script's expand switch.
    return undefined;
  }

  // Pointer motion: light up the row under it, but never consume the packet —
  // pi still needs it for drag-selection. Repaint only when the row changes.
  if (event?.type === "move") {
    if (!hoverTracking) return undefined;
    hoverClaimed = true;
    const row = hoverRowAt(plan, y);
    const changed = setHover(row ? tool : null, row, tool.ui);
    if (changed) tool.ui?.requestRender?.();
    return undefined;
  }
  if (plan.header) {
    if (y === 0) {
      if (!click) return undefined;
      if (plan.header === "closed") openGroup(tool);
      else {
        closeGroupJobDetails(tool);
        for (const member of closeGroup(tool)) routing.asPointer(() => (member as GroupedTool).setExpanded(false));
      }
      // 行几何变了，上一帧的高亮不再对应原来那一行
      setHover(null, null);
      // 层级是跨组件的状态;pi 每帧都重渲染整个 transcript,请求一帧即可
      tool.ui?.requestRender?.();
      return { handled: true };
    }
    y -= 1;
  }
  if (plan.line) {
    if (y !== 0 || !click) return undefined;
    // A row always means "this call's box" — also the running/failed row
    // under a folded header, which opens the group on the way.
    openGroup(tool);
    setHover(null, null);
    // 走 setExpanded 而不是直接改字段:pi 的 updateDisplay 才会重建盒子
    routing.asPointer(() => tool.setExpanded(true));
    tool.ui?.requestRender?.();
    return { handled: true };
  }
  // dy is one less than the row above the border: the box's own leading blank
  // row is dropped when it is drawn under the gutter.
  if (plan.full) return routing.boxMouse(event, boxIndent(tool, plan), (plan.header ? 1 : 0) - 1);
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boundary hooks
// ─────────────────────────────────────────────────────────────────────────────

const BOUNDARY_WRAPPER = Symbol.for("pi-toolbox:group-boundary");
/** This carrier's thinking was expanded by a click on its `🧠` row. */
const THOUGHT_OPEN = Symbol.for("pi-toolbox:thought-open");
const CARRIER_MOUSE = Symbol.for("pi-toolbox:carrier-mouse");
/**
 * Where this frame put the rows a click can land on. `null` = this frame drew
 * no carrier rows at all, so nothing here belongs to us — the record has to be
 * per frame because a component's role changes under it: an assistant step
 * streams as a carrier, then its text arrives and it becomes a boundary.
 */
const CARRIER_CLICK = Symbol.for("pi-toolbox:carrier-click");
type CarrierClickMap = { header: number | null; from: number; to: number };

/**
 * Last renderer a tool handed us. Carrier components have no `ui` of their own,
 * and a hovered row needs a repaint, so we borrow the neighbouring tool's.
 */
let lastUi: Renderer | undefined;

/**
 * A carrier message inside an open group: one `🧠` row per thinking run. The
 * collapsed row is the whole point — the group header counts the runs, and the
 * rows are where the model's reasoning actually shows up in the transcript.
 *
 * Clicking a row expands *that message's* thinking: pi draws it (markdown, its
 * own colour) from `thinkingVisibilityOverrides`, the same switch pi's own
 * click uses, so the two can never disagree. pi's `hideThinkingBlock` setting
 * is deliberately ignored here: the row is the one behaviour, open or shut.
 */
function renderCarrier(component: any, width: number): BoundaryDraw {
  const message = component.lastMessage;
  const runs = thinkingRuns(message);
  const plan = carrierPlan(component, { ids: toolCallIds(message), runs });
  // The run count just changed and the summary line is drawn by someone else:
  // ask for the frame that catches it up.
  if (plan.counted) lastUi?.requestRender?.();
  // A live run goes quiet on its own after its last token. By then pi may be
  // painting nothing at all, so the frame that drops the row is ours.
  if (plan.settlesIn !== undefined) scheduleSettle(component, plan.settlesIn);
  if (plan.plain) return "plain";
  const theme = getTheme();
  if (!theme || width <= GUTTER_CELLS + 8) return "plain";
  const icons = iconsEnabled();
  const thinkingColor = thinkingColorFor();
  installCarrierMouse(component);
  const lines: string[] = [];
  // Row indices of what this frame draws, in the component's own coordinates.
  // `from` is -1 while no thought row has been drawn: an empty range.
  const clickMap: CarrierClickMap = { header: null, from: -1, to: -1 };
  component[CARRIER_CLICK] = clickMap;
  if (plan.header) {
    const line = groupHeaderLine(
      component,
      plan.header,
      theme,
      width,
      icons,
      hoverState.tool === component && hoverState.row === "header",
      Date.now(),
    );
    if (line !== undefined) {
      clickMap.header = lines.length;
      lines.push(line);
    }
  }
  if (!plan.rows) return { lines };
  const context = GUTTER_CELLS + THOUGHT_LABEL_CELLS;
  const gutter = groupGutter(theme);
  const hovered = hoverState.tool === component && hoverState.row === "row";
  // `thinkingVisibilityOverrides` is pi's own per-run switch: false = shown, and
  // pi renders the markdown itself. We flip the same map, so its click and
  // ours can never disagree about what is open.
  const open = component[THOUGHT_OPEN] === true && component.thinkingVisibilityOverrides?.get?.(0) === false;
  if (component[THOUGHT_OPEN] && !open) {
    // pi's own click on the expanded text folded it again; follow it.
    component[THOUGHT_OPEN] = false;
  }
  // Folded, a live run is a sliding window: one row, newest words, so the group
  // says what it is working on without being opened. The animation lives on the
  // summary line, not here — and the window moves on a tick, not per frame.
  const now = Date.now();
  const liveTexts = plan.live && !open ? liveRowText(component, runs, runs.map(() => width - context), now) : undefined;
  const firstRow = lines.length;
  for (const [index, run] of runs.entries()) {
    const text = liveTexts?.[index] ?? previewText(run, width - context);
    const row = formatThoughtLine(text, theme, { icons, thinkingColor });
    // Open: the row keeps its place and takes a tick, exactly like an opened
    // call — the reasoning hangs under it instead of replacing it.
    const line = open ? `${tickGutter(theme)} ${row.trimStart()}` : gutter + row;
    lines.push(hovered ? hoverBand(line, width, theme) : truncateToWidth(line, width, "…"));
  }
  if (open) {
    const body = trimBlankEdges(renderThinkingBody(component, iconBodyWidth(width)));
    for (const line of body) lines.push(`${gutter}${BODY_PAD}${theme.fg("thinkingText", line)}`);
  }
  clickMap.from = firstRow;
  clickMap.to = lines.length - 1;
  return { lines };
}

/** The width an opened thinking run's text is laid out at, inside its indent. */
function iconBodyWidth(width: number): number {
  return Math.max(8, width - BODY_INDENT);
}

/**
 * pi's own rendering of the expanded run (markdown, its colours, code blocks) —
 * pulled through the message's thinking child rather than re-implemented.
 */function renderThinkingBody(component: any, width: number): string[] {
  const kids = component.contentContainer?.children;
  if (Array.isArray(kids)) {
    for (const kid of kids) if (kid instanceof MouseRegion) return kid.render(width) as string[];
  }
  return [];
}

/**
 * Clicks on a `🧠` row unfold that message's thinking; motion lights the row.
 * Both are ours to route — the component draws the rows itself, so nothing
 * below it is listening.
 *
 * Everything outside the rows this frame drew goes back to the handler that was
 * here before us. A component's role changes under it (a streaming step is a
 * carrier, the same object becomes a boundary when its text arrives), and a
 * handler that answered "row" to every `y` swallowed the whole message: any
 * click below the row opened the thinking instead of reaching the text.
 */
function installCarrierMouse(component: any): void {
  if (component[CARRIER_MOUSE]) return;
  component[CARRIER_MOUSE] = true;
  const previous = component.handleMouse;
  const pass = (event: any) => previous?.call(component, event);
  /** Where `y` sits in what this frame drew, or null when it is not ours. */
  const rowAt = (y: unknown): HoverRow | null => {
    const map = component[CARRIER_CLICK] as CarrierClickMap | null | undefined;
    if (!map || typeof y !== "number" || y < 0) return null;
    if (map.header !== null && y === map.header) return "header";
    return map.from >= 0 && y >= map.from && y <= map.to ? "row" : null;
  };
  component.handleMouse = (event: any) => {
    if (event?.type === "move") {
      if (!hoverTracking) return pass(event);
      const row = rowAt(event.y);
      // Only a row claims the packet; the alt-screen hook drops the band when
      // nothing does, so motion across the rest of the message clears it.
      if (row) hoverClaimed = true;
      if (setHover(row ? component : null, row, lastUi)) lastUi?.requestRender?.();
      return pass(event);
    }
    if (event?.type !== "click" || (event.button !== "left" && event.button !== 0)) return pass(event);
    const theme = getTheme();
    if (!theme) return pass(event);
    const row = rowAt(event.y);
    if (!row) return pass(event);
    // Expanded, the run's box hangs under its row and the whole block is ours:
    // the frame was drawn by us, so the click that folds it back has to be too.
    // Only its own rows: the summary line is a second target on the same
    // component, and an expanded run beside it used to eat the header's click
    // (the group stayed open and the reasoning folded instead).
    const expanded = component[THOUGHT_OPEN] && component.thinkingVisibilityOverrides?.get?.(0) === false;
    if (expanded && row === "row") {
      const overrides = component.thinkingVisibilityOverrides;
      for (let i = 0; i < Math.max(1, thinkingRuns(component.lastMessage).length); i++) overrides?.set?.(i, true);
      component[THOUGHT_OPEN] = false;
      component.updateContent?.(component.lastMessage);
      component.invalidate?.();
      setHover(null, null);
      lastUi?.requestRender?.();
      return { handled: true };
    }
    if (row === "header") {
      // Same toggle the first member's header does: shut folds every box inside.
      const { header } = carrierPlan(component);
      if (header === "closed") openGroup(component);
      else {
        closeGroupJobDetails(component);
        for (const member of closeGroup(component)) (member as GroupedTool).setExpanded(false);
      }
      setHover(null, null);
      lastUi?.requestRender?.();
      return { handled: true };
    }
    const overrides = component.thinkingVisibilityOverrides;
    for (let i = 0; i < Math.max(1, thinkingRuns(component.lastMessage).length); i++) overrides?.set?.(i, false);
    component[THOUGHT_OPEN] = true;
    component.updateContent?.(component.lastMessage);
    component.invalidate?.();
    setHover(null, null);
    lastUi?.requestRender?.();
    return { handled: true };
  };
}

type RenderFn = ((this: any, ...args: any[]) => string[]) & { [BOUNDARY_WRAPPER]?: true };

/** Whether grouping is on right now (the tool patch keeps this current). */
let groupingActive: () => boolean = () => true;

/** Whether Nerd Font icons are on (`icons: false` on a terminal without one). */
let iconsEnabled: () => boolean = () => true;
/** `tidy.thinkingColor`: the brain, the count and an expanded box border. */
let thinkingColorFor: () => string = () => "warning";

export function setGroupingActive(active: () => boolean): void {
  groupingActive = active;
}

export function setIconsEnabled(icons: () => boolean): void {
  iconsEnabled = icons;
}

export function setThinkingColor(color: () => string): void {
  thinkingColorFor = color;
}

/**
 * A live thinking row changes on a tick, not on every frame: pi repaints while
 * streaming, and a window recomputed per paint slides one cell per token, which
 * reads as flicker. The row keeps its last string until the tick expires.
 */
const liveRows = new WeakMap<object, { at: number; texts: string[] }>();

/**
 * The preview for one live run, held steady between ticks. Text short enough to
 * fit is shown whole and never moves; only an overflowing run slides.
 */
function liveRowText(component: object, runs: string[], budgets: number[], now: number): string[] {
  const cached = liveRows.get(component);
  if (cached && now - cached.at < THOUGHT_TICK_MS && cached.texts.length === runs.length) return cached.texts;
  const texts = runs.map((run, i) => previewText(run, budgets[i] ?? 0, true));
  liveRows.set(component, { at: now, texts });
  return texts;
}

/**
 * What a boundary component draws this frame: `plain` trims pi's padding,
 * `untrimmed` preserves the render verbatim, `rethink` restyles its `Thinking...`
 * labels (see `restyleThinking`), `lines` are drawn verbatim, `hidden` draws
 * nothing.
 */
type BoundaryDraw = "hidden" | "plain" | "untrimmed" | "rethink" | { lines: string[] };

/** A box border costs two cells of its width. */
const BOX_CELLS = 2;

/**
 * pi draws thinking as a child component of the message: a one-line label while
 * it is hidden, the full markdown once it is shown, wrapped in a `MouseRegion`
 * so a click toggles it. That child is where our rows belong, so the message is
 * reassembled child by child: every other child keeps pi's own lines verbatim
 * (they carry the OSC 133 prompt markers), and each thinking child becomes a
 * `thinking` row — or, expanded, the same rounded box a tool result gets.
 *
 * A `MouseRegion` sits around the body, so a click on our row still reaches pi's
 * toggle: collapsed → expanded → collapsed. `hideThinkingBlock` is ignored: the
 * run starts hidden here no matter what pi's setting says, so the first click is
 * always "open it".
 */
/** Rows an expanded run occupies (title + box) on its message component. */
const THOUGHT_SPANS = Symbol.for("pi-toolbox:thought-spans");
const RETHINK_MOUSE = Symbol.for("pi-toolbox:rethink-mouse");

/**
 * pi's own click region covers a thinking child by its *rendered height*, and we
 * changed that height: a one-line label became a title plus a box, and the
 * padding rows around the message were trimmed away. So the toggle is ours: a
 * click on a run's row (or its open box) folds that run, and a click on a
 * collapsed row opens it.
 */
function installRethinkMouse(component: any): void {
  if (component[RETHINK_MOUSE]) return;
  component[RETHINK_MOUSE] = true;
  const previous = component.handleMouse;
  component.handleMouse = (event: any) => {
    const click = event?.type === "click" && (event.button === "left" || event.button === 0);
    const spans = (component[THOUGHT_SPANS] ?? []) as Array<{ from: number; to: number; run: number }>;
    const overrides = component.thinkingVisibilityOverrides as Map<number, boolean> | undefined;
    const toggle = (run: number) => {
      // The map is "hidden": toggle whatever it says.
      const shown = overrides?.get?.(run) === false;
      overrides?.set?.(run, shown);
      component.updateContent?.(component.lastMessage);
      component.invalidate?.();
      lastUi?.requestRender?.();
      return { handled: true };
    };
    const hit = click ? spans.find((span) => event.y >= span.from && event.y <= span.to) : undefined;
    if (hit) return toggle(hit.run);
    // A message that is nothing but thinking has no other content to click: the
    // whole block belongs to the run, whatever the row arithmetic says.
    if (click) {
      const runs = thinkingRuns(component.lastMessage);
      const content = Array.isArray(component.lastMessage?.content) ? component.lastMessage.content : [];
      const hasText = content.some((block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim());
      if (!hasText && runs.length === 1) return toggle(0);
      // A click that missed every run is not pi's either: its regions sit on the
      // *untrimmed* layout, so one row under a run would hit pi's label and
      // toggle a block nobody aimed at. Our spans cover every run, open or shut.
      return undefined;
    }
    return previous?.call(component, event);
  };
}

function restyleThinking(component: any, renderOriginal: () => string[], width: number): string[] {
  const theme = getTheme();
  const runs = thinkingRuns(component.lastMessage);
  const kids = component.contentContainer?.children;
  if (!theme || runs.length === 0 || !Array.isArray(kids) || kids.length === 0) return renderOriginal();
  const regions = kids.filter((kid: any) => kid instanceof MouseRegion);
  // These are private Pi internals: do not guess at a different child layout,
  // or leave a partial patch on a region an extension has made non-configurable.
  if (regions.length !== runs.length || regions.some((kid: any) => {
    const own = Object.getOwnPropertyDescriptor(kid, "render");
    return own ? !own.configurable : !Object.isExtensible(kid);
  })) return renderOriginal();
  const overrides = component.thinkingVisibilityOverrides as Map<number, boolean> | undefined;
  for (let i = 0; i < runs.length; i++) if (!overrides?.has?.(i)) overrides?.set?.(i, true);

  const icons = iconsEnabled();
  const color = thinkingColorFor();
  // This row is drawn outside a group, so nothing else on screen can say "still
  // arriving": the row slides over the tail and wears the spinner itself, the
  // way the summary does inside a group. It settles on the same three signals.
  noteThinking(component, runs);
  const thought = thinkingState(component);
  if (thought.settlesIn !== undefined) scheduleSettle(component, thought.settlesIn);
  const budget = Math.max(1, width - THOUGHT_LABEL_CELLS - 1);
  const liveTexts = thought.live ? liveRowText(component, runs, runs.map(() => budget), Date.now()) : undefined;
  const spinner = thought.live ? thinkingSpinner(Date.now()) : undefined;
  const patched: Array<{ kid: any; descriptor: PropertyDescriptor | undefined }> = [];
  try {
    for (let i = 0; i < regions.length; i++) {
      const kid = regions[i];
      const original = kid.render;
      const descriptor = Object.getOwnPropertyDescriptor(kid, "render");
      const shown = overrides?.get?.(i) === false;
      let own: string[] | undefined;
      // Pi's Markdown caches one width. Both the predecessor's render and our
      // height measurement must use the FINAL body width, not alternate W and
      // W-2 every frame. A folded run needs no body render at all. This adapter
      // is scoped to this transaction; other extensions keep their renderer.
      Object.defineProperty(kid, "render", {
        configurable: true,
        writable: true,
        value: () => own ??= shown ? original.call(kid, Math.max(4, width - BOX_CELLS)) : [""],
      });
      patched.push({ kid, descriptor });
    }
    const lines = renderOriginal();
    const out: string[] = [];
    /** Rows of every run row plus its box: the click target for toggling it. */
    const spans: Array<{ from: number; to: number; run: number }> = [];
    let cursor = 0;
    let run = 0;
    for (const kid of kids) {
      const own = kid.render(width) as string[];
      const taken = lines.slice(cursor, cursor + own.length);
      cursor += own.length;
      if (!(kid instanceof MouseRegion)) {
        out.push(...(taken.length === own.length ? taken : own));
        continue;
      }
      const text = liveTexts?.[run] ?? previewText(runs[run] ?? "", budget);
      const shown = overrides?.get?.(run) === false;
      run++;
      // The label stays in both states: outside a group the box is the only
      // frame, so it needs the title above it to say what it is.
      out.push(formatThoughtLine(text, theme, { icons, thinkingColor: color, spinner }));
      const from = out.length - 1;
      if (shown) {
        const body = trimBlankEdges(own);
        out.push(...(body.length > 0 ? drawFrame(body, width, theme, color) : []));
      }
      // Pi can attach its closing zone markers to the last thinking child.
      // Preserve them when replacing that child's original rows with our box.
      const markers = taken.join("").match(ZONE_MARKERS) ?? [];
      out[from] = markers.filter((m) => m.includes(";A")).join("") + out[from];
      out[out.length - 1] += markers.filter((m) => !m.includes(";A")).join("");
      spans.push({ from, to: out.length - 1, run: run - 1 });
    }
    out.push(...lines.slice(cursor));
    // Padding can carry OSC 133 markers: ignore escapes when shifting clicks.
    const lead = out.findIndex((line) => line.replace(WITHOUT_ESCAPES, "").trim() !== "");
    const shift = lead > 0 ? lead : 0;
    component[THOUGHT_SPANS] = spans.map((span) => ({ ...span, from: span.from - shift, to: span.to - shift }));
    installRethinkMouse(component);
    return trimMessageEdges(out);
  } finally {
    for (const { kid, descriptor } of patched) {
      if (descriptor) Object.defineProperty(kid, "render", descriptor);
      else delete kid.render;
    }
  }
}

/** A rendered row with every escape sequence gone: what the reader sees. */
const WITHOUT_ESCAPES = /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g;
/** pi's shell-integration zone markers, which ride on the rows we trim. */
const ZONE_MARKERS = /\x1b\]133;[ABC]\x07/g;

/**
 * Trim pi's padding rows off a message block, without dropping the OSC 133 zone
 * markers that sit on them: the terminal uses those to place prompts, so they
 * move onto the rows that survive.
 */
function trimMessageEdges(lines: string[]): string[] {
  const blank = (line: string | undefined) => (line ?? "").replace(WITHOUT_ESCAPES, "").trim() === "";
  let start = 0;
  let end = lines.length;
  while (start < end && blank(lines[start])) start++;
  while (end > start && blank(lines[end - 1])) end--;
  if (start === 0 && end === lines.length) return lines;
  if (start === end) return [];
  const kept = lines.slice(start, end);
  const head = lines.slice(0, start).join("").match(ZONE_MARKERS) ?? [];
  const tail = lines.slice(end).join("").match(ZONE_MARKERS) ?? [];
  if (head.length > 0) kept[0] = head.join("") + kept[0];
  if (tail.length > 0) kept[kept.length - 1] = kept[kept.length - 1] + tail.join("");
  return kept;
}

/**
 * Wrap `proto.render` unless the outermost wrapper is already ours. `view`
 * decides per render: draw as usual, draw nothing, draw under the group
 * gutter (two cells narrower, `│` in front), or draw its own rows.
 */
function wrapBoundaryRender(proto: { render?: RenderFn } | undefined, view: (component: any, width: number) => BoundaryDraw): void {
  const render = proto?.render;
  if (typeof render !== "function" || render[BOUNDARY_WRAPPER]) return;
  const wrapped: RenderFn = function (this: any, ...args: any[]) {
    if (!groupingActive()) return render.apply(this, args);
    const [width, ...rest] = args;
    // Click geometry is per frame. A component whose role changed (a streaming
    // step stops being a carrier once its text arrives) must stop answering
    // clicks at the rows it used to draw.
    this[CARRIER_CLICK] = null;
    this[THOUGHT_SPANS] = [];
    const how = view(this, typeof width === "number" ? width : 80);
    if (how === "hidden") return [];
    if (how === "untrimmed") return render.apply(this, args);
    // Compact assistant/custom message edges around a group. User messages opt
    // out above so their padding still separates turns.
    const trim = (lines: string[]) => trimMessageEdges(lines);
    if (how === "rethink") return trim(restyleThinking(this, () => render.apply(this, args), typeof width === "number" ? width : 80));
    if (typeof how === "object") return how.lines;
    return trim(render.apply(this, args));
  };
  wrapped[BOUNDARY_WRAPPER] = true;
  proto!.render = wrapped;
}

/**
 * Group boundaries are seen through the message components' render. These
 * wrappers must be the *outermost* layer: pi-starline restyles
 * UserMessageComponent with a render patch that never calls its predecessor,
 * so a wrapper installed underneath it (pi-tidy loads first) would never run.
 * Hence this runs at patch time and again from the tool render, by which time
 * every extension has installed its patches.
 */
export function installGroupBoundaries(): void {
  wrapBoundaryRender((AssistantMessageComponent as any)?.prototype, (component, width) => {
    const role = classifyAssistant(component.lastMessage);
    if (role === "boundary") noteBoundary(component);
    else if (role === "carrier") return renderCarrier(component, width);
    // A step still streaming its thinking mid-segment is, almost always, a
    // carrier whose tool call hasn't arrived yet. Fold it with the group now
    // rather than flash `Thinking...` under the summary for a second; text,
    // if it comes, makes it a boundary and it shows. At a turn's start the
    // group is empty and the label stays as a sign of life.
    else if (component.isStreaming === true && currentGroupHasMembers()) {
      return renderCarrier(component, width);
    }
    // A message with both thinking and text is the group *boundary*: its text
    // renders as pi draws it and its thinking stays pi's own label — but the
    // label is the same thing our rows are, so it wears the same format, right
    // above the text. It is not one of the group's rows, so it is not counted.
    return "rethink";
  });
  wrapBoundaryRender((UserMessageComponent as any)?.prototype, (component) => {
    noteBoundary(component);
    return "untrimmed";
  });
  // A background job's notifications (`[process] "ticker" matched stdout:
  // READY`) say what its row already shows. The model still receives them —
  // this only skips drawing them. Everything else keeps its own edges: a custom
  // message is pi's `Box(1, 1, customMessageBg)` too, so the same trim that ate
  // the user message's padding was eating its inset as well.
  wrapBoundaryRender((CustomMessageComponent as any)?.prototype, (component) =>
    noteJobMessage(component.message) ? "hidden" : "untrimmed",
  );
}
