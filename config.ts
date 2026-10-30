import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MessageBorderColors {
  user: string;
  compaction: string;
  branch: string;
  skill: string;
  custom: string;
}

export interface TidyConfig {
  enabled: boolean;
  /** Opt-in input frame and compact footer; native editing remains unchanged. */
  editorStyle: "native" | "quiet";
  highlightBash: boolean;
  /** Give message boxes the same rounded transparent frame as tool boxes. */
  frameMessages: boolean;
  /** Frame user messages too — off by default because pi-starline owns them. */
  frameUserMessages: boolean;
  /** Prepend Nerd Font icons (tool kind / file type / message kind). */
  icons: boolean;
  /**
   * Collapsed bash result preview height, in visual lines (default 1). pi's own
   * bash renderer hard-codes 5 and has no setting; `ctrl+o` still shows everything.
   */
  bashResultLines: number;
  /**
   * Collapsed write preview height, in visual lines (default 10, pi's own
   * number). `0` hides the preview until the box is expanded.
   */
  writeLines: number;
  /**
   * Collapse one assistant segment's tool calls into a single summary line.
   * Click the line for one row per call, click a row for the full box.
   */
  groupTools: boolean;
  /**
   * Tools that never fold into a group and keep pi's own box (edit/write by
   * default: the diff is the point). They also end the group before them.
   */
  alwaysShowTools: string[];
  /** Track background jobs (pi-processes) on the row of the call that started them. */
  backgroundJobs: boolean;
  /** Hide a job's notification messages when its row already shows them. */
  hideJobNotifications: boolean;
  /**
   * Render an edit's diff as two panes (old | new) with line numbers, a
   * coloured bar and a tinted row per changed line. Falls back to pi's
   * unified diff when the box is too narrow (see `splitDiffMinWidth`).
   */
  splitDiff: boolean;
  /** Box width below which the split becomes unreadable; pi's diff is used. */
  splitDiffMinWidth: number;
  /**
   * Diff body rows shown while collapsed (default 0: summary only). A positive
   * budget follows the first changed line; opening the box shows all rows.
   * edit has no such budget of its own — pi draws the whole diff.
   */
  diffLines: number;
  /** Per-kind theme fg colors for message-box borders (any ThemeColor name). */
  messageBorderColors: MessageBorderColors;
  /**
   * Theme color for thinking: the `🧠` row, the counting entry in the summary
   * line, and the border of an expanded thinking box. Any theme color name or
   * `#rrggbb`.
   */
  thinkingColor: string;
  /**
   * Per-tool border color for successful executions (theme fg color names;
   * pending stays grey, error stays red). When set in settings, the map
   * REPLACES the defaults entirely — `{}` disables per-tool colors.
   */
  toolColors: Record<string, string>;
}

/** pi's own collapsed write preview height; `writeLines` defaults to it. */
export const PI_WRITE_PREVIEW_LINES = 10;

const DEFAULT_TOOL_COLORS: Record<string, string> = {
  bash: "bashMode",
  read: "toolTitle",
  edit: "syntaxVariable",
  write: "syntaxVariable",
  grep: "syntaxOperator",
  find: "syntaxOperator",
  ls: "syntaxOperator",
  mcp: "customMessageLabel",
};

const DEFAULTS: TidyConfig = {
  enabled: true,
  editorStyle: "native",
  highlightBash: true,
  frameMessages: true,
  frameUserMessages: false,
  icons: true,
  bashResultLines: 1,
  writeLines: PI_WRITE_PREVIEW_LINES,
  groupTools: true,
  alwaysShowTools: ["edit", "write"],
  backgroundJobs: true,
  hideJobNotifications: true,
  splitDiff: true,
  splitDiffMinWidth: 72,
  diffLines: 0,
  thinkingColor: "warning",
  messageBorderColors: {
    user: "toolTitle",
    compaction: "customMessageLabel",
    branch: "mdCode",
    skill: "accent",
    custom: "warning",
  },
  toolColors: DEFAULT_TOOL_COLORS,
};

function readSettings(): any {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
}

export function loadConfig(): TidyConfig {
  try {
    // `tidy` since the rename from pi-toolbox; the old key keeps working.
    const settings = readSettings();
    const toolbox = settings?.tidy ?? settings?.toolbox;
    return {
      enabled: toolbox?.enabled ?? DEFAULTS.enabled,
      editorStyle: toolbox?.editorStyle === "quiet" ? "quiet" : DEFAULTS.editorStyle,
      highlightBash: toolbox?.highlightBash ?? DEFAULTS.highlightBash,
      frameMessages: toolbox?.frameMessages ?? DEFAULTS.frameMessages,
      frameUserMessages: toolbox?.frameUserMessages ?? DEFAULTS.frameUserMessages,
      icons: toolbox?.icons ?? DEFAULTS.icons,
      bashResultLines: typeof toolbox?.bashResultLines === "number" ? toolbox.bashResultLines : DEFAULTS.bashResultLines,
      writeLines: typeof toolbox?.writeLines === "number" ? toolbox.writeLines : DEFAULTS.writeLines,
      groupTools: typeof toolbox?.groupTools === "boolean" ? toolbox.groupTools : DEFAULTS.groupTools,
      alwaysShowTools: Array.isArray(toolbox?.alwaysShowTools)
        ? toolbox.alwaysShowTools.filter((name: unknown): name is string => typeof name === "string")
        : DEFAULTS.alwaysShowTools,
      backgroundJobs: typeof toolbox?.backgroundJobs === "boolean" ? toolbox.backgroundJobs : DEFAULTS.backgroundJobs,
      hideJobNotifications:
        typeof toolbox?.hideJobNotifications === "boolean" ? toolbox.hideJobNotifications : DEFAULTS.hideJobNotifications,
      splitDiff: typeof toolbox?.splitDiff === "boolean" ? toolbox.splitDiff : DEFAULTS.splitDiff,
      splitDiffMinWidth:
        typeof toolbox?.splitDiffMinWidth === "number" ? toolbox.splitDiffMinWidth : DEFAULTS.splitDiffMinWidth,
      diffLines: typeof toolbox?.diffLines === "number" ? toolbox.diffLines : DEFAULTS.diffLines,
      thinkingColor: typeof toolbox?.thinkingColor === "string" ? toolbox.thinkingColor : DEFAULTS.thinkingColor,
      messageBorderColors: {
        ...DEFAULTS.messageBorderColors,
        ...toolbox?.messageBorderColors,
      },
      // Replace, not merge: removing a tool's color must be expressible.
      toolColors: toolbox?.toolColors ?? DEFAULTS.toolColors,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

