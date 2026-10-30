/**
 * Rounded transparent frames for *every* tool box.
 *
 * Re-registering tools with `renderShell: "self"` only reaches tools this
 * extension registers itself — tools owned by other extensions (MCP via
 * pi-mcp-adapter, subagents, …) keep pi's default filled-background shell,
 * and the extension API exposes no way to wrap another extension's renderers
 * (`getAllTools()` returns name/description/parameters only).
 *
 * So the frame is applied one level lower, on ToolExecutionComponent — the
 * component pi builds for every tool call regardless of who registered it.
 * Extensions import the same live module instance as the host app, so
 * patching the prototype reaches every tool box in the session.
 *
 * The patches are installed once and read their options from a global slot,
 * so a `/reload` with new settings reaches them (see live.ts).
 */

import { homedir } from "node:os";
import { Box, Container, visibleWidth } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { blankEdges, drawFrame, outsideHyperlink, removeLeadingWord, sameLines, visibleIndexOf } from "./frame-draw.ts";
import { sliceByColumn } from "@earendil-works/pi-tui";
import { fileIcon, PATH_ARG_TOOLS, toolKindIcon } from "./icons.ts";
import { closeJobDetails, jobsForTool, setJobOptions } from "./background-jobs.ts";
import { liveSlot, tidyEnabled } from "./live.ts";
import { createSplitDiffRenderer, renderUnifiedDiff } from "./split-diff.ts";
import { getTheme, type ThemeLike } from "./theme-access.ts";
import { noteSetExpanded } from "./tool-groups.ts";
import {
  installGroupBoundaries,
  installHoverTracking,
  NOT_GROUPED,
  renderGroupedTool,
  routeGroupedMouse,
  setGroupingActive,
  setIconsEnabled,
  setThinkingColor,
  type GroupedTool,
} from "./tool-group-view.ts";

interface MouseTarget {
  render(width: number): string[];
  handleMouse?(event: unknown): unknown;
}

interface EditCallComponent extends MouseTarget {
  preview?: { diff?: unknown; error?: unknown };
  children?: ReadonlyArray<EditCallComponent>;
}

/**
 * Where the box's source rows sit in the framed output, so a click can be
 * translated back into the coordinates pi's own components expect.
 */
interface FrameGeometry {
  /** Output row of source row 0 (rows above it were trimmed padding). */
  top: number;
  /** Source rows rendered, and the width they were rendered at. */
  height: number;
  width: number;
  /** false when the frame was dropped (a body hanging under a group row): column 0 is the body. */
  bordered?: boolean;
}

interface ToolBoxInternals extends GroupedTool {
  hideComponent: boolean;
  toolName: string;
  result?: { isError: boolean; durationMs?: number; content?: unknown; details?: unknown };
  selfRenderContainer: MouseTarget;
  contentBox: MouseTarget;
  contentText: MouseTarget;
  /** The MouseRegion pi wraps around `contentText` (no renderer definition). */
  contentTextRegion?: MouseTarget;
  imageComponents: Array<{ render(width: number): string[] }>;
  imageSpacers: Array<{ render(width: number): string[] }>;
  /** The component pi wrapped around the call renderer's output (the edit Box). */
  callRendererComponent?: EditCallComponent;
  resultRendererComponent?: EditCallComponent;
  hasRendererDefinition(): boolean;
  getRenderShell(): "default" | "self";
  __frameCache?: {
    width: number;
    color: string;
    expanded: boolean;
    icons: boolean;
    unframed: boolean;
    raw: string[];
    out: string[];
    geometry: FrameGeometry;
  };
  __frameGeometry?: FrameGeometry;
}

export interface ToolFrameOptions {
  /** Prepend a Nerd Font icon (tool kind or target file type) to the call row. */
  icons?: boolean;
  /** Per-tool-name border color for successful executions (theme fg color names). */
  toolColors?: Record<string, string>;
  /**
   * Collapse each assistant segment's tool calls into one summary line
   * (`▸ 4 calls · bash×3 read×1`), expanding to one row per call, then to the
   * full box. Click a line to step down a level; `ctrl+o` still expands all.
   */
  groupTools?: boolean;
  /** Tools that never fold into a group (default edit/write: the diff is the point). */
  alwaysShowTools?: string[];
  /**
   * Track background jobs a call started (pi-processes): the row shows the
   * job's live state instead of the call's.
   */
  backgroundJobs?: boolean;
  /** Skip drawing a job's notification messages when its row shows the same. */
  hideJobNotifications?: boolean;
  /** Render the edit diff as two panes (old | new) when the box is wide enough. */
  splitDiff?: boolean;
  /** Box width below which the split falls back to pi's unified diff (default 72). */
  splitDiffMinWidth?: number;
  /** Diff rows shown while collapsed (default 0: summary only). */
  diffLines?: number;
  /** Theme color for thinking rows and the expanded thinking box (default `warning`). */
  thinkingColor?: string;
}

interface ResolvedToolFrameOptions {
  icons: boolean;
  toolColors: Record<string, string>;
  groupTools: boolean;
  alwaysShow: Set<string>;
  splitDiff: boolean;
  splitDiffMinWidth: number;
  diffLines: number;
  thinkingColor: string;
}

const toolOptions = liveSlot<ResolvedToolFrameOptions>("tool-frame-options", {
  icons: false,
  toolColors: {},
  groupTools: true,
  alwaysShow: new Set(["edit", "write"]),
  splitDiff: true,
  splitDiffMinWidth: 72,
  diffLines: 0,
  thinkingColor: "warning",
});

// Weak ownership releases cached diff text/layout with the history component.
// Keep one last layout per mode/owner, so alternating edits cannot thrash.
const editDiffRenderers = new WeakMap<ToolBoxInternals, {
  split: ReturnType<typeof createSplitDiffRenderer>;
  unified: ReturnType<typeof createSplitDiffRenderer>;
}>();

const grouping = () => tidyEnabled.get() && toolOptions.get().groupTools;

/** The component pi routes a box's clicks through (its result MouseRegions live inside). */
function mouseTarget(tool: ToolBoxInternals): MouseTarget | undefined {
  if (!tool.hasRendererDefinition()) return tool.contentTextRegion;
  return tool.getRenderShell() === "self" ? tool.selfRenderContainer : tool.contentBox;
}

export function patchToolBoxFrames(options: ToolFrameOptions = {}): void {
  const {
    icons = false,
    toolColors = {},
    groupTools = true,
    alwaysShowTools = ["edit", "write"],
    backgroundJobs = true,
    hideJobNotifications = true,
    splitDiff = true,
    splitDiffMinWidth = 72,
    diffLines = 0,
    thinkingColor = "warning",
  } = options;
  toolOptions.set({
    icons,
    toolColors,
    groupTools,
    alwaysShow: new Set(alwaysShowTools),
    splitDiff,
    splitDiffMinWidth,
    diffLines,
    thinkingColor,
  });
  setJobOptions({ enabled: backgroundJobs, hideNotifications: hideJobNotifications });

  const proto = ToolExecutionComponent.prototype as unknown as ToolBoxInternals & {
    render(width: number): string[];
    __toolboxFramed?: boolean;
  };
  if (proto.__toolboxFramed) return;
  proto.__toolboxFramed = true;

  const originalRender = proto.render;
  const anyProto = proto as unknown as Record<string, any>;
  const originalHandleMouse = anyProto.handleMouse;
  const originalSetExpanded = anyProto.setExpanded;
  const originalInvalidate = anyProto.invalidate;
  anyProto.invalidate = function (this: ToolBoxInternals, ...args: any[]) {
    editDiffRenderers.delete(this);
    this.__frameCache = undefined;
    return originalInvalidate?.apply(this, args);
  };

  setGroupingActive(grouping);
  setIconsEnabled(() => toolOptions.get().icons);
  setThinkingColor(() => toolOptions.get().thinkingColor);
  installGroupBoundaries();
  installHoverTracking();

  // >0 while pi's own mouse handling runs: its box click reaches setExpanded
  // from in here, ctrl+o's expand/collapse-all from anywhere else.
  let pointerDepth = 0;
  const asPointer = <T>(fn: () => T): T => {
    pointerDepth++;
    try {
      return fn();
    } finally {
      pointerDepth--;
    }
  };

  /**
   * A click on the framed box, translated into the source component's own
   * coordinates. pi's handler would measure the *unframed* layout (and, for
   * `renderShell: "self"` tools, read a height only its own render records),
   * so clicks landed on the wrong row or — for edit and MCP boxes — nowhere.
   */
  function boxMouse(this: ToolBoxInternals, event: any, dx = 0, dy = 0): unknown {
    const geometry = this.__frameGeometry;
    const target = mouseTarget(this);
    if (!geometry || typeof target?.handleMouse !== "function") {
      return asPointer(() => originalHandleMouse?.call(this, event));
    }
    const y = event.y - dy - geometry.top;
    if (y >= 0 && y < geometry.height) {
      // Column 0 of the source sits right of the left border — unless the frame
      // was dropped, in which case the body starts where the row does.
      const x = event.x - dx - (geometry.bordered === false ? 0 : 1);
      const handled = asPointer(() =>
        target.handleMouse!({ ...event, x, y, width: geometry.width, height: geometry.height }),
      );
      if (handled !== undefined) return handled;
    }
    // Nothing under the pointer took it. The rows we draw are not always rows
    // pi's own layout knows about: a split diff is painted here, so pi's
    // sub-components keep the height they had before the preview arrived (a
    // streamed frame leaves them at two or three rows), and an unframed body is
    // shifted by the gutter. Every cell of the box is the expand switch, so a
    // click that found no owner toggles it here instead of doing nothing.
    const click = event?.type === "click" && (event.button === "left" || event.button === 0);
    if (!click) return undefined;
    asPointer(() => this.setExpanded(!this.expanded));
    return { handled: true };
  }

  anyProto.handleMouse = function (this: ToolBoxInternals, event: any) {
    if (!tidyEnabled.get()) return originalHandleMouse?.call(this, event);
    if (grouping()) {
      const routed = routeGroupedMouse(this, event, {
        pinned: toolOptions.get().alwaysShow.has(this.toolName),
        asPointer,
        boxMouse: (shifted, dx, dy) => boxMouse.call(this, shifted, dx, dy),
      });
      if (routed !== NOT_GROUPED) return routed;
    }
    return boxMouse.call(this, event);
  };

  // ctrl+o 与 pi 自己的展开都走 setExpanded:先改层级,再让 pi 记自己的状态
  anyProto.setExpanded = function (this: ToolBoxInternals, expanded: boolean) {
    if (grouping()) {
      if (!expanded && pointerDepth === 0 && !toolOptions.get().alwaysShow.has(this.toolName)) {
        closeJobDetails(jobsForTool(this).map((job) => job.id));
      }
      noteSetExpanded(this, expanded, pointerDepth > 0);
    }
    return originalSetExpanded.call(this, expanded);
  };

  /**
 * Tools whose body is a diff worth splitting. pi's write box previews the new
 * file as highlighted source, not a diff, so it is not one of them.
 */
const EDIT_DIFF_TOOLS = new Set(["edit"]);

interface EditDiffSource {
  diff: string;
  header: MouseTarget;
}

function emptyContainer(component: EditCallComponent): boolean {
  return component.render === Container.prototype.render && component.children?.length === 0;
}

/** Find the native call inside transparent wrappers, without rendering a body.
 * Disabled pi-quiet still wraps the call and appends an empty result Container.
 * Stop at meaningful siblings/unknown layouts; never discard custom content.
 */
function editDiffSource(tool: ToolBoxInternals): EditDiffSource | undefined {
  if (!EDIT_DIFF_TOOLS.has(tool.toolName) || tool.result?.isError) return undefined;
  if (tool.resultRendererComponent && !emptyContainer(tool.resultRendererComponent)) return undefined;
  let component = tool.callRendererComponent;
  for (let depth = 0; component && depth < 16; depth++) {
    // A single child alone does not make a wrapper transparent: an overridden
    // renderer can prepend warnings without adding them to `children`.
    if (component.render !== Container.prototype.render && component.render !== Box.prototype.render) return undefined;
    if ("preview" in component || "previewArgsKey" in component) {
      const header = component.children?.[0];
      if (typeof header?.render !== "function") return undefined;
      const details = tool.result?.details;
      const settledDiff = details && typeof details === "object" && "diff" in details ? details.diff : undefined;
      // Saved successful output is authoritative, even if a filesystem preview
      // is missing, stale, or failed after the file was subsequently changed.
      if (typeof settledDiff === "string") return settledDiff.trim() ? { diff: settledDiff, header } : undefined;
      const preview = component.preview;
      return preview && !("error" in preview) && typeof preview.diff === "string" && preview.diff.trim()
        ? { diff: preview.diff, header } : undefined;
    }
    const children = component.children;
    if (!children?.length || children.some((child, index) => index > 0 && !emptyContainer(child))) return undefined;
    component = children[0];
  }
  return undefined;
}

/** Rebuild a recognized native edit as a budgeted split or unified preview. */
function editDiffBody(
  tool: ToolBoxInternals,
  innerWidth: number,
  callWidth: number,
  theme: ThemeLike,
  edit: EditDiffSource | undefined,
): { raw: string[]; bgRows: ReadonlySet<number> } | undefined {
  const { splitDiff, splitDiffMinWidth, diffLines } = toolOptions.get();
  if (!edit) return undefined;
  const { diff, header } = edit;
  const path = (tool.args as { path?: unknown } | undefined)?.path;
  let renderers = editDiffRenderers.get(tool);
  if (!renderers) {
    renderers = { split: createSplitDiffRenderer(), unified: createSplitDiffRenderer(renderUnifiedDiff) };
    editDiffRenderers.set(tool, renderers);
  }
  const input = {
    diff,
    width: innerWidth,
    theme,
    filePath: typeof path === "string" ? path : undefined,
    // Collapsed, the body is a window on the diff; `ctrl+o` draws all of it.
    maxLines: tool.expanded ? undefined : diffLines,
  };
  const split = splitDiff && innerWidth >= splitDiffMinWidth ? renderers.split(input) : null;
  const body = split ?? renderers.unified(input);
  if (!body) return undefined;
  // Row 0 is the call row (`edit ~/x.ts`), which keeps pi's rendering so the
  // icon prefix and path shortening still apply; the body starts with its own
  // summary row (`↳ diff +1 -1 [...]`).
  const call = header.render(callWidth);
  const offset = call.length;
  return {
    raw: [...call, ...body.lines],
    bgRows: new Set(body.bgRows.map((row) => row + offset)),
  };
}

/** The rounded box at width `w` (what pi would draw, reframed). */
  function frameBox(this: ToolBoxInternals, w: number, theme: ThemeLike, unframed = false): string[] {
    const { icons, toolColors } = toolOptions.get();
    const source = !this.hasRendererDefinition()
      ? this.contentText
      : this.getRenderShell() === "self"
        ? this.selfRenderContainer
        : this.contentBox;
    // The icon cells come off the call row's render width so nothing
    // truncates. Layout: ` <kind> <file> /tmp/x.ts` — the kind icon leads
    // (replacing the tool-name word, which is removed as redundant), the
    // file-type icon sits directly in front of the path (the same role
    // `$` plays for bash). When the path can't be located in the rendered
    // row, the file icon falls back into the prefix.
    let kindPrefix = "";
    let fileGlyph = "";
    let filePath = "";
    if (icons) {
      kindPrefix = ` ${toolKindIcon(this.toolName)} `;
      if (PATH_ARG_TOOLS.has(this.toolName)) {
        const p = (this.args as { path?: unknown } | undefined)?.path;
        if (typeof p === "string" && p) {
          fileGlyph = fileIcon(p);
          filePath = p;
        }
      }
    }
    const iconCells = (kindPrefix ? visibleWidth(kindPrefix) : 0) + (fileGlyph ? visibleWidth(fileGlyph) + 1 : 0);
    const edit = editDiffSource(this);
    // A separate, non-link toggle: Pi activates OSC 8 filename links before
    // dispatching a click to a component. Reserve these cells on the call row.
    const toggle = edit ? `${this.expanded ? "▾" : "▸"} ` : "";
    const sourceWidth = w - 2 - iconCells - visibleWidth(toggle);
    const split = editDiffBody(this, w - 2, sourceWidth, theme, edit);
    const raw = split ? split.raw : source.render(sourceWidth);

    // The whole returned array is cached, not just the framed body.
    // pi-powerline-footer's compositor re-renders the entire root on every
    // mouse packet while scrolling, so an unchanged box must cost a key
    // check and nothing more — no re-framing its lines.
    //
    // Border color tracks tool state, then per-tool identity: pending is
    // grey and error is red no matter what; a successful box takes its
    // tool's configured color, falling back to the theme accent.
    const color = this.isPartial ? "borderMuted" : this.result?.isError ? "error" : toolColors[this.toolName] || "accent";
    // Image boxes skip the cache entirely: the line key says nothing about
    // an image component being swapped in (kitty PNG conversion finishes
    // asynchronously and rebuilds them), so a hit would freeze the box on
    // its pre-conversion frame.
    const cacheable = this.imageComponents.length === 0;
    const cache = this.__frameCache;
    if (
      cacheable &&
      cache &&
      cache.width === w &&
      cache.color === color &&
      cache.expanded === this.expanded &&
      cache.icons === icons &&
      cache.unframed === unframed &&
      sameLines(cache.raw, raw)
    ) {
      this.__frameGeometry = cache.geometry;
      return cache.out;
    }

    // pi's default shell pads content by one cell on every side; the frame
    // supplies the vertical part, so only the blank padding rows are dropped.
    // `Text` hands back its own cached array — never write into `raw`.
    const edges = blankEdges(raw);
    let content = edges.start === 0 && edges.end === raw.length ? raw : raw.slice(edges.start, edges.end);
    if (icons && content.length > 0) {
      let first = content[0];
      // The kind icon already names the tool — drop the redundant word.
      if (PATH_ARG_TOOLS.has(this.toolName)) {
        const stripped = removeLeadingWord(first, this.toolName);
        if (stripped !== first) first = stripped.replace(/^ +/, "");
      }
      let row = kindPrefix + first;
      if (fileGlyph) {
        // renderToolPath shortens $HOME to `~` in the display text — try
        // the raw path first, then its shortened form.
        const home = homedir();
        const candidates = filePath.startsWith(home) ? [filePath, `~${filePath.slice(home.length)}`] : [filePath];
        let at = -1;
        for (const candidate of candidates) {
          const idx = visibleIndexOf(row, candidate);
          if (idx >= 0) {
            at = outsideHyperlink(row, idx);
            break;
          }
        }
        row = at >= 0 ? row.slice(0, at) + fileGlyph + " " + row.slice(at) : kindPrefix + fileGlyph + " " + first;
      }
      content = [row, ...content.slice(1)];
    }
    if (split && toggle && content.length > 0) {
      content = [theme.fg("muted", toggle) + content[0], ...content.slice(1)];
    }
    // Unframed means the call row is already the row above it: the body is the
    // output, not the command again. The blank row that separated them goes too.
    if (unframed && content.length > 0) {
      content = content.slice(1);
      const rest = blankEdges(content);
      content = rest.start === 0 && rest.end === content.length ? content : content.slice(rest.start, rest.end);
    }
    const drawn: string[] = [];
    if (content.length > 0) {
      // Split-diff rows carry their own tint; everything else stays transparent.
      const bgRows = split && edges.start > 0
        ? new Set([...split.bgRows].map((row) => row - edges.start).filter((row) => row >= 0))
        : split?.bgRows;
      const framed = drawFrame(content, w, theme, color, bgRows);
      // Unframed: the row above already carries the frame of reference (the
      // group rail), so only the body is drawn — borders dropped, cells kept.
      if (unframed) {
        // Borders dropped, cells kept: the body is the content columns only.
        for (const line of framed.slice(1, -1)) drawn.push(sliceByColumn(line, 1, Math.max(1, w - 2)));
      } else {
        for (const line of framed) drawn.push(line);
      }
    }
    // No leading spacer: the box butts against whatever came before it. pi
    // puts one there for its own unframed shell, which we replaced with the
    // frame — inside a transcript it just reads as a stray blank row.
    const out: string[] = drawn;
    // Output: [spacer, top border, content…, bottom border] — content row 0
    // is source row `edges.start`. Unframed drops the spacer and both borders,
    // so the body starts on the first line.
    const geometry: FrameGeometry = unframed
      ? { top: -(edges.start + 1), height: raw.length, width: sourceWidth - 2, bordered: false }
      : { top: 1 - edges.start, height: raw.length, width: sourceWidth };
    this.__frameGeometry = content.length > 0 ? geometry : undefined;
    // Images stay outside the frame: their lines carry terminal graphics
    // payloads that padding/truncation would corrupt.
    for (let i = 0; i < this.imageComponents.length; i++) {
      const spacer = this.imageSpacers[i];
      if (spacer) for (const line of spacer.render(w)) out.push(line);
      const image = this.imageComponents[i];
      if (image) for (const line of image.render(w)) out.push(line);
    }

    if (out.length === 0) return [];
    if (cacheable) this.__frameCache = { width: w, color, expanded: this.expanded, icons, unframed, raw, out, geometry };
    return out;
  }

  proto.render = function (this: ToolBoxInternals, width: number): string[] {
    const theme = getTheme();
    if (!theme || !tidyEnabled.get()) {
      this.__frameGeometry = undefined;
      return originalRender.call(this, width);
    }
    try {
      if (this.hideComponent) return [];
      const w = Math.max(4, width);
      if (grouping()) {
        const { icons, alwaysShow } = toolOptions.get();
        const grouped = renderGroupedTool(
          this,
          w,
          theme,
          { icons, pinned: alwaysShow.has(this.toolName) },
          (boxWidth, unframed) => frameBox.call(this, boxWidth, theme, unframed),
        );
        if (grouped) return grouped;
      }
      return frameBox.call(this, w, theme);
    } catch {
      this.__frameGeometry = undefined;
      return originalRender.call(this, width);
    }
  };
}
