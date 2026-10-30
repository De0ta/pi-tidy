/**
 * Side-by-side (old | new) and budgeted unified bodies for the `edit` tool's diff.
 *
 * pi renders an edit preview as a unified diff string (`+12 text`, `- 7 text`,
 * `  3 text`) and colours each line with toolDiffAdded / toolDiffRemoved /
 * toolDiffContext. Two panes read better for block replacements, so this module
 * parses that string and re-renders it: line numbers on both sides, a coloured
 * bar on changed rows, a tinted row background, and word-level emphasis on
 * paired lines. Same information pi already has — no file access, no internals.
 *
 * The tint is derived from the theme (diff colour mixed into the tool box
 * background), so it follows whatever theme pi is running.
 */

import { getLanguageFromPath, highlightCode, keyHint, renderDiff } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ThemeLike } from "./theme-access.ts";

/** Blank cells on each side of the panes (pi's Box uses the same padding). */
const PAD = 1;
const SEPARATOR = " │ ";
/** Narrower panes than this and the caller should keep pi's unified diff. */
const MIN_CONTENT_WIDTH = 20;
const TAB = "    ";

export interface SplitDiffInput {
  /** pi's unified diff string (`details.diff`) */
  diff: string;
  /** Total width available, padding included */
  width: number;
  theme: ThemeLike;
  /** Used only to pick a highlighter language. */
  filePath?: string;
  /**
   * Rows of diff body to draw (`diffLines` while collapsed). Undefined draws
   * all of them. The window is anchored at the first changed row — cutting at
   * the top of a diff on a large file would hide the change itself.
   */
  maxLines?: number;
}

export interface SplitDiffOutput {
  lines: string[];
  /** Rows that carry their own background fill — the frame must not strip it. */
  bgRows: number[];
}

interface Cell {
  num: number | null;
  text: string;
  changed: boolean;
}

interface Row {
  kind: "row" | "skip";
  left?: Cell;
  right?: Cell;
}

interface ParsedLine {
  prefix: "+" | "-" | " ";
  num: number | null;
  text: string;
  skip: boolean;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Palette {
  addedFg: string;
  removedFg: string;
  contextFg: string;
  addedBar: string;
  removedBar: string;
  addedBg: string | undefined;
  removedBg: string | undefined;
  addedEmphasis: string | undefined;
  removedEmphasis: string | undefined;
  separator: string;
}

// ── parsing ─────────────────────────────────────────────────────────────────

/** `+12 text` / `- 7 text` / `  3 text`, plus pi's `      ...` skip marker. */
const LINE_RE = /^([+\- ])(\s*)(\d*)(?:\s(.*))?$/;

function parseLine(raw: string): ParsedLine | null {
  const match = LINE_RE.exec(raw);
  if (!match) return null;
  const prefix = match[1] as ParsedLine["prefix"];
  const digits = match[3] ?? "";
  const text = match[4] ?? "";
  const num = digits ? Number.parseInt(digits, 10) : null;
  return { prefix, num, text, skip: num === null && text.trim() === "..." };
}

/**
 * Group into rows. pi emits each change as a run of `-` lines followed by a run
 * of `+` lines, so a run pairs by index: the i-th removed line sits next to the
 * i-th added one, and a longer side leaves the other cell blank.
 *
 * Context lines only carry the old number; the new one is the old plus the
 * running addition/deletion delta.
 */
function buildRows(parsed: readonly ParsedLine[]): Row[] {
  const rows: Row[] = [];
  let delta = 0;
  let i = 0;
  while (i < parsed.length) {
    const line = parsed[i]!;
    if (line.skip) {
      rows.push({ kind: "skip" });
      i++;
      continue;
    }
    if (line.prefix === " ") {
      const next = line.num === null ? null : line.num + delta;
      rows.push({
        kind: "row",
        left: { num: line.num, text: line.text, changed: false },
        right: { num: next, text: line.text, changed: false },
      });
      i++;
      continue;
    }
    const removed: ParsedLine[] = [];
    while (i < parsed.length && parsed[i]!.prefix === "-") removed.push(parsed[i++]!);
    const added: ParsedLine[] = [];
    while (i < parsed.length && parsed[i]!.prefix === "+") added.push(parsed[i++]!);
    if (removed.length === 0 && added.length === 0) {
      i++; // unreachable in practice; never spin on a line we cannot classify
      continue;
    }
    delta += added.length - removed.length;
    const pairs = Math.max(removed.length, added.length);
    for (let k = 0; k < pairs; k++) {
      const left = removed[k];
      const right = added[k];
      rows.push({
        kind: "row",
        ...(left ? { left: { num: left.num, text: left.text, changed: true } } : {}),
        ...(right ? { right: { num: right.num, text: right.text, changed: true } } : {}),
      });
    }
  }
  return rows;
}

// ── colour ──────────────────────────────────────────────────────────────────

/** The SGR prefix a theme slot expands to, e.g. `\x1b[38;2;166;227;161m`. */
function sgr(theme: ThemeLike, slot: string, kind: "fg" | "bg" = "fg"): string | undefined {
  try {
    const ansi = kind === "bg" ? theme.bg?.(slot, "x") : theme.fg(slot, "x");
    if (!ansi) return undefined;
    const end = ansi.indexOf("m");
    return end > 0 ? ansi.slice(0, end + 1) : undefined;
  } catch {
    return undefined;
  }
}

const XTERM_16: Rgb[] = [
  { r: 0, g: 0, b: 0 },
  { r: 205, g: 49, b: 49 },
  { r: 13, g: 188, b: 121 },
  { r: 229, g: 229, b: 16 },
  { r: 36, g: 114, b: 200 },
  { r: 188, g: 63, b: 188 },
  { r: 17, g: 168, b: 205 },
  { r: 229, g: 229, b: 229 },
  { r: 102, g: 102, b: 102 },
  { r: 241, g: 76, b: 76 },
  { r: 35, g: 209, b: 139 },
  { r: 245, g: 245, b: 67 },
  { r: 59, g: 142, b: 234 },
  { r: 214, g: 112, b: 214 },
  { r: 41, g: 184, b: 219 },
  { r: 255, g: 255, b: 255 },
];

function xterm256(index: number): Rgb {
  if (index < 16) return XTERM_16[index] ?? XTERM_16[0]!;
  if (index < 232) {
    const steps = [0, 95, 135, 175, 215, 255];
    const value = index - 16;
    return {
      r: steps[Math.floor(value / 36)]!,
      g: steps[Math.floor((value % 36) / 6)]!,
      b: steps[value % 6]!,
    };
  }
  const grey = 8 + (index - 232) * 10;
  return { r: grey, g: grey, b: grey };
}

/** Read a colour out of an SGR sequence (truecolour, 256, or the basic 16). */
function sgrRgb(sequence: string | undefined): Rgb | null {
  if (!sequence) return null;
  const params = sequence.slice(2, -1).split(";").map((part) => Number.parseInt(part, 10));
  const at = params.indexOf(38) >= 0 ? params.indexOf(38) : params.indexOf(48);
  if (at >= 0) {
    if (params[at + 1] === 2) {
      const [r, g, b] = [params[at + 2], params[at + 3], params[at + 4]];
      if (r === undefined || g === undefined || b === undefined) return null;
      return { r, g, b };
    }
    if (params[at + 1] === 5 && params[at + 2] !== undefined) return xterm256(params[at + 2]!);
    return null;
  }
  const code = params[0];
  if (code === undefined || !Number.isFinite(code)) return null;
  if (code >= 30 && code <= 37) return XTERM_16[code - 30] ?? null;
  if (code >= 90 && code <= 97) return XTERM_16[code - 90 + 8] ?? null;
  return null;
}

/**
 * An absolute background for a diff row: a fixed slice of the diff hue over a
 * dimmed box background. Mixing the hue into the box background directly (the
 * way a translucent overlay would) washes out at the strengths that stay
 * readable — a 14% pink over #28293a is a plum band, not a removed line. Hue
 * carries the meaning, luminance has to stay low.
 */
function tintBackground(base: Rgb, color: Rgb, hue: number): Rgb {
  return {
    r: Math.round(color.r * hue + base.r * 0.35),
    g: Math.round(color.g * hue + base.g * 0.35),
    b: Math.round(color.b * hue + base.b * 0.35),
  };
}

function bgAnsi(color: Rgb): string {
  return `\x1b[48;2;${color.r};${color.g};${color.b}m`;
}

/**
 * Paint a row: the fill goes first and is re-armed after every SGR reset inside
 * the text (syntax highlighting emits its own `\x1b[0m`, which would otherwise
 * punch a hole in the tint).
 */
function paint(text: string, fill: string): string {
  let out = fill;
  let index = 0;
  const RESET = /\x1b\[0?m/g;
  for (const match of text.matchAll(RESET)) {
    const start = match.index ?? 0;
    out += text.slice(index, start) + match[0] + fill;
    index = start + match[0].length;
  }
  return `${out}${text.slice(index)}\x1b[49m`;
}

function buildPalette(theme: ThemeLike): Palette {
  const addedFg = sgr(theme, "toolDiffAdded");
  const removedFg = sgr(theme, "toolDiffRemoved");
  const contextFg = sgr(theme, "toolDiffContext");
  // The row tint has no theme slot, so mix the diff colour into the box
  // background the way an editor would: 14% for the row, 30% for the word.
  const base = sgrRgb(sgr(theme, "toolSuccessBg", "bg")) ?? sgrRgb(sgr(theme, "toolPendingBg", "bg"));
  const added = sgrRgb(addedFg);
  const removed = sgrRgb(removedFg);
  const tint = (color: Rgb | null, hue: number): string | undefined =>
    base && color ? bgAnsi(tintBackground(base, color, hue)) : undefined;
  return {
    addedFg: addedFg ?? "",
    removedFg: removedFg ?? "",
    contextFg: contextFg ?? "",
    addedBar: sgr(theme, "toolDiffAdded") ?? "",
    removedBar: sgr(theme, "toolDiffRemoved") ?? "",
    addedBg: tint(added, 0.16),
    removedBg: tint(removed, 0.16),
    addedEmphasis: tint(added, 0.32),
    removedEmphasis: tint(removed, 0.32),
    separator: contextFg ?? "",
  };
}

// ── text ────────────────────────────────────────────────────────────────────

/** Drop control characters (a diff of a file containing ESC must not reach the terminal). */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\t/g, TAB);
}

function highlighter(filePath: string | undefined): (line: string) => string {
  let language: string | undefined;
  try {
    language = filePath ? getLanguageFromPath(filePath) : undefined;
  } catch {
    language = undefined;
  }
  const cache = new Map<string, string>();
  return (line) => {
    const cached = cache.get(line);
    if (cached !== undefined) return cached;
    let out = line;
    if (language && line.trim()) {
      try {
        out = highlightCode(line, language)[0] ?? line;
      } catch {
        out = line;
      }
    }
    cache.set(line, out);
    return out;
  };
}

/** Longest common prefix and suffix, in code units. */
function commonEdges(left: string, right: string): { prefix: number; suffix: number } {
  const max = Math.min(left.length, right.length);
  let prefix = 0;
  while (prefix < max && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

/**
 * Wrap the changed middle of `rendered` (already coloured) in the emphasis
 * fill. Boundaries are visible-character indices, so escape sequences inside
 * the highlighted text do not shift them.
 */
function emphasize(rendered: string, start: number, end: number, fill: string, restore: string | undefined): string {
  if (end <= start) return rendered;
  const back = restore ?? "\x1b[49m";
  let out = "";
  let visible = 0;
  let inside = false;
  let index = 0;
  while (index < rendered.length) {
    const char = rendered[index]!;
    if (char === "\x1b") {
      const stop = rendered.indexOf("m", index);
      if (stop !== -1) {
        out += rendered.slice(index, stop + 1);
        index = stop + 1;
        continue;
      }
    }
    if (!inside && visible === start) {
      out += fill;
      inside = true;
    }
    if (inside && visible === end) {
      out += back;
      inside = false;
    }
    out += char;
    visible++;
    index++;
  }
  return inside ? out + back : out;
}

function pad(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible === width) return text;
  if (visible > width) return truncateToWidth(text, width, "");
  return text + " ".repeat(width - visible);
}

// ── rendering ───────────────────────────────────────────────────────────────

interface Layout {
  /** Bar column, then a space, the number, a space, then the code. */
  numWidth: number;
  pane: number;
  content: number;
}

function layout(width: number, rows: readonly Row[]): Layout | null {
  let maxNumber = 0;
  for (const row of rows) {
    for (const cell of [row.left, row.right]) {
      if (cell?.num !== null && cell?.num !== undefined) maxNumber = Math.max(maxNumber, cell.num);
    }
  }
  // "old" / "new" sit over the number column, so it is at least three wide.
  const numWidth = Math.max(3, String(maxNumber).length);
  const available = width - PAD * 2 - SEPARATOR.length;
  if (available < (numWidth + 3) * 2 + MIN_CONTENT_WIDTH * 2) return null;
  const pane = Math.floor(available / 2);
  const content = pane - numWidth - 3;
  if (content < MIN_CONTENT_WIDTH) return null;
  return { numWidth, pane, content };
}

function numberFg(changed: boolean, kind: "add" | "remove" | "context", palette: Palette): string {
  if (!changed) return palette.contextFg;
  return kind === "add" ? palette.addedFg : palette.removedFg;
}

function renderCell(
  cell: Cell | undefined,
  kind: "add" | "remove" | "context",
  lay: Layout,
  palette: Palette,
  highlight: (line: string) => string,
  emphasis: { start: number; end: number } | undefined,
): string {
  if (!cell) {
    // The other pane has nothing on this row: keep the cell blank so the two
    // columns stay aligned, and leave it untinted like an empty diff line.
    return " ".repeat(lay.pane);
  }
  const changed = cell.changed;
  const fg = numberFg(changed, kind, palette);
  const fill = kind === "add" ? palette.addedBg : kind === "remove" ? palette.removedBg : undefined;
  const emphFill = kind === "add" ? palette.addedEmphasis : palette.removedEmphasis;
  const bar = changed ? (kind === "add" ? palette.addedBar : palette.removedBar) : palette.contextFg;

  const raw = sanitize(cell.text);
  let body = highlight(raw);
  if (changed && emphasis && emphFill) {
    body = emphasize(body, emphasis.start, emphasis.end, emphFill, fill);
  }
  body = pad(truncateToWidth(body, lay.content, ""), lay.content);

  const num = cell.num === null ? "" : String(cell.num);
  const label = num.padStart(lay.numWidth);
  // Bar first, then the number: the marker sits in its own column, so the
  // digits line up down the pane and the bar reads as a margin.
  const line = `${bar}${changed ? "▌" : " "}\x1b[39m ${fg}${label}\x1b[39m ${body}`;
  return pad(fill ? paint(line, fill) : line, lay.pane);
}

/**
 * Render the diff as two panes. Returns null when the width cannot hold a
 * readable split — the caller then keeps pi's unified diff.
 *
 * Callers rendering a persistent component can use `createSplitDiffRenderer`
 * to retain its last layout without other edit boxes evicting it.
 */
/**
 * The line under the call row: `↳ diff +3 -1 [+++----]`.
 *
 * The bar is proportional (lazygit's summary line), not a histogram — one
 * glance says how lopsided the edit is. Both halves keep at least one cell
 * when both sides are non-zero, so "mostly additions" still shows the red.
 */
function renderSummary(add: number, remove: number, width: number, palette: Palette): string {
  const prefix = `${palette.contextFg}↳ diff\x1b[39m ${palette.addedFg}+${add}\x1b[39m ${palette.removedFg}-${remove}\x1b[39m`;
  const room = width - PAD * 2 - visibleWidth(`↳ diff +${add} -${remove} []`);
  if (add + remove === 0 || room < 2) return pad(`${' '.repeat(PAD)}${prefix}${' '.repeat(PAD)}`, width);
  // One cell per changed line (capped), but never so short the ratio is a guess.
  const bar = Math.min(room, 32, Math.max(8, add + remove));
  let added = Math.round((bar * add) / (add + remove));
  if (add > 0 && remove > 0) added = Math.min(bar - 1, Math.max(1, added));
  if (add === 0) added = 0;
  if (remove === 0) added = bar;
  const removed = bar - added;
  const graph = `${palette.contextFg}[${palette.addedFg}${'+'.repeat(added)}${palette.removedFg}${'-'.repeat(removed)}${palette.contextFg}]`;
  return pad(`${' '.repeat(PAD)}${prefix} ${graph}\x1b[39m${' '.repeat(PAD)}`, width);
}

export function renderSplitDiff(input: SplitDiffInput): SplitDiffOutput | null {
  return build(input);
}

/** Native unified colors/wrapping, with the same collapsed budget as a split. */
export function renderUnifiedDiff(input: SplitDiffInput): SplitDiffOutput | null {
  const { diff, width, theme, filePath, maxLines } = input;
  if (!diff.trim() || width < 4) return null;
  const raw = diff.split("\n");
  let added = 0;
  let removed = 0;
  for (const line of raw) {
    const parsed = parseLine(line);
    if (parsed?.prefix === "+") added++;
    if (parsed?.prefix === "-") removed++;
  }
  const colored = renderDiff(raw.map(sanitize).join("\n"), { filePath }).split("\n");
  // A wrapped context continuation can start with '+'/'-'. Carry the original
  // diff-line classification through wrapping instead of guessing from its text.
  const rows = colored.flatMap((line, index) => {
    const prefix = parseLine(raw[index] ?? "")?.prefix;
    const changed = prefix === "+" || prefix === "-";
    return wrapTextWithAnsi(line, width - PAD * 2).map((text) => ({ text, changed }));
  });
  const window = clip(rows, maxLines, (row) => row.changed);
  const label = (text: string) => theme.fg("toolDiffContext", text);
  const lines = [renderSummary(added, removed, width, buildPalette(theme))];
  if (window.above > 0) lines.push(pad(` ${label(`… ${window.above} lines above`)}`, width));
  for (const row of window.rows) lines.push(pad(` ${row.text} `, width));
  if (window.below > 0) {
    const hint = keyHint("app.tools.expand", "to expand");
    lines.push(pad(` ${label(`… (${window.below} more lines, ${rows.length} total, click or`)} ${hint}${label(")")}`, width));
  }
  return { lines, bgRows: [] };
}

/**
 * One last-result cache per owner, not per module. Drop the renderer when its
 * component is invalidated (including in-place theme changes). Keeping only
 * the last input bounds memory while streaming, resizing or expanding a diff.
 */
export function createSplitDiffRenderer(render: typeof renderSplitDiff = renderSplitDiff): typeof renderSplitDiff {
  let memo: { input: SplitDiffInput; value: SplitDiffOutput | null } | undefined;
  return (input) => {
    const previous = memo?.input;
    if (
      previous &&
      previous.diff === input.diff &&
      previous.width === input.width &&
      previous.theme === input.theme &&
      previous.filePath === input.filePath &&
      previous.maxLines === input.maxLines
    ) return memo!.value;
    const value = render(input);
    memo = { input: { ...input }, value };
    return value;
  };
}

function build(input: SplitDiffInput): SplitDiffOutput | null {
  const { diff, width, theme, filePath } = input;
  const parsed: ParsedLine[] = [];
  for (const raw of diff.split("\n")) {
    const line = parseLine(raw);
    if (line) parsed.push(line);
    else if (raw.trim()) parsed.push({ prefix: " ", num: null, text: raw, skip: false });
  }
  if (parsed.length === 0) return null;
  const rows = buildRows(parsed);
  const lay = layout(width, rows);
  if (!lay) return null;

  const palette = buildPalette(theme);
  const highlight = highlighter(filePath);
  const lines: string[] = [];
  const bgRows: number[] = [];

  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.left?.changed) removed++;
    if (row.right?.changed) added++;
  }
  lines.push(renderSummary(added, removed, width, palette));

  const label = (text: string) => `${palette.contextFg}${text}\x1b[39m`;
  const separator = `${palette.separator}${SEPARATOR}\x1b[39m`;
  const header = `  ${label("old".padStart(lay.numWidth))} ${" ".repeat(lay.content)}${separator}  ${label("new".padStart(lay.numWidth))} ${" ".repeat(lay.content)}`;
  const window = clip(rows, input.maxLines, (row) => !!(row.left?.changed || row.right?.changed));
  // A zero budget is "just the summary": column headers over nothing read as a
  // rendering bug rather than a setting.
  if (window.rows.length > 0) lines.push(pad(" ".repeat(PAD) + header + " ".repeat(PAD), width));

  if (window.above > 0) {
    lines.push(pad(`${" ".repeat(PAD)}${label(`… ${window.above} line${window.above === 1 ? "" : "s"} above`)}`, width));
  }

  for (const row of window.rows) {
    if (row.kind === "skip") {
      lines.push(pad(`${" ".repeat(PAD)}${label("…")}`, width));
      continue;
    }
    const spans = row.left && row.right ? commonEdges(row.left.text, row.right.text) : undefined;
    const leftEmphasis =
      row.left && row.right && row.left.changed
        ? {
            start: spans!.prefix,
            end: row.left.text.length - spans!.suffix,
          }
        : undefined;
    const rightEmphasis =
      row.left && row.right && row.right.changed
        ? {
            start: spans!.prefix,
            end: row.right.text.length - spans!.suffix,
          }
        : undefined;

    const left = renderCell(
      row.left,
      row.left?.changed ? "remove" : "context",
      lay,
      palette,
      highlight,
      leftEmphasis,
    );
    const right = renderCell(
      row.right,
      row.right?.changed ? "add" : "context",
      lay,
      palette,
      highlight,
      rightEmphasis,
    );
    const line = `${" ".repeat(PAD)}${left}${separator}${right}${" ".repeat(PAD)}`;
    if (row.left?.changed || row.right?.changed) bgRows.push(lines.length);
    lines.push(pad(line, width));
  }

  if (window.below > 0) {
    const hint = keyHint("app.tools.expand", "to expand");
    const total = rows.length;
    lines.push(
      pad(
        `${" ".repeat(PAD)}${label(`… (${window.below} more line${window.below === 1 ? "" : "s"}, ${total} total, click or`)} ${hint}${label(")")}`,
        width,
      ),
    );
  }

  return { lines, bgRows };
}

/**
 * The slice of rows to draw. Without a budget that is all of them; with one,
 * the window is anchored at the first changed row with a third of the budget
 * of context above it, so a one-line change in a 200-line file still shows the
 * line. Rows the window skips are reported on either side.
 */
function clip<T>(
  rows: readonly T[],
  maxLines: number | undefined,
  changed: (row: T) => boolean,
): { rows: readonly T[]; above: number; below: number } {
  const budget = maxLines === undefined ? rows.length : Math.max(0, Math.floor(maxLines));
  if (budget >= rows.length) return { rows, above: 0, below: 0 };
  if (budget === 0) return { rows: [], above: 0, below: rows.length };
  const first = rows.findIndex(changed);
  const anchor = first < 0 ? 0 : first;
  const lead = Math.min(Math.floor(budget / 3), budget);
  const start = Math.max(0, Math.min(anchor - lead, rows.length - budget));
  const end = start + budget;
  return { rows: rows.slice(start, end), above: start, below: rows.length - end };
}
