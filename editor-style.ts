/**
 * Editor-only presentation inspired by pi-quiet's QuietEditor (MIT, zenspc).
 * See THIRD_PARTY_NOTICES.md. No transcript, palette, header or footer hooks.
 */
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type EditorComponent,
} from "@earendil-works/pi-tui";
import type { TidyConfig } from "./config.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

export interface QuietEditorInfo {
  model: string;
  thinking: string;
  muted(text: string): string;
  accent(text: string): string;
}

const LEFT = 4;
const RIGHT = 2;
const MIN_WIDTH = 12;

function label(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

/** Clip terminal columns, not UTF-16 units, without losing the IME cursor. */
function fit(line: string, width: number): string {
  const clipped = truncateToWidth(line, width, "");
  return line.includes(CURSOR_MARKER) && !clipped.includes(CURSOR_MARKER) ? CURSOR_MARKER + clipped : clipped;
}

/** Adapt only a native layout. Unknown custom editors are left completely alone. */
export function decorateQuietEditor(editor: EditorComponent, info: () => QuietEditorInfo): (() => void) | undefined {
  const top = Reflect.get(editor, "renderTopBorder");
  const bottom = Reflect.get(editor, "renderBottomBorder");
  if (
    typeof top !== "function" || typeof bottom !== "function" || typeof editor.handleMouse !== "function" ||
    editor.render !== Editor.prototype.render ||
    editor.handleMouse !== Editor.prototype.handleMouse ||
    (top !== Reflect.get(Editor.prototype, "renderTopBorder") && top !== Reflect.get(CustomEditor.prototype, "renderTopBorder")) ||
    bottom !== Reflect.get(Editor.prototype, "renderBottomBorder") ||
    typeof editor.borderColor !== "function"
  ) return undefined;

  const names = ["render", "handleMouse", "renderTopBorder", "renderBottomBorder"] as const;
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(editor, name));
  if (!Object.isExtensible(editor) || descriptors.some((d) => d && !d.configurable)) return undefined;
  const originalRender = editor.render;
  const originalMouse = editor.handleMouse!;
  const border = (text: string) => editor.borderColor!(text);
  let outerWidth: number | undefined;
  let bottomLine: string | undefined;
  let active = true;
  let framed = false;

  const methods = {
    renderTopBorder(width: number, hidden: number): string {
      if (outerWidth === undefined) return top.call(editor, width, hidden);
      // Keep Pi's own working indicator and hidden-line count, including ANSI.
      const native = top.call(editor, outerWidth, hidden) as string;
      return border("╭") + sliceByColumn(native, 1, outerWidth - 2) + border("╮");
    },
    renderBottomBorder(width: number, hidden: number): string {
      if (outerWidth === undefined) return bottom.call(editor, width, hidden);
      const current = info();
      const budget = outerWidth - 5;
      const level = label(current.thinking);
      const suffix = level === "off" ? "" : ` (${level})`;
      const hiddenLabel = hidden > 0 ? `↓ ${hidden} more · ` : "";
      const overflow = budget >= visibleWidth(hiddenLabel + suffix) + 8 ? hiddenLabel : "";
      const modelBudget = Math.max(0, budget - visibleWidth(suffix) - visibleWidth(overflow));
      let text = current.muted(overflow + truncateToWidth(label(current.model), modelBudget, "…")) + current.accent(suffix);
      text = truncateToWidth(text, budget, "…");
      const used = visibleWidth(text);
      bottomLine = border("╰" + "─".repeat(Math.max(0, outerWidth - used - 5)) + " ") + text + border(" ─╯");
      return bottomLine;
    },
    render(width: number): string[] {
      if (!active) return originalRender.call(editor, width);
      framed = false;
      const columns = Math.max(0, Math.floor(width));
      if (!columns) return [];
      if (columns < MIN_WIDTH) {
        outerWidth = undefined;
        return originalRender.call(editor, Math.max(4, columns)).map((line) => fit(line, columns));
      }
      outerWidth = columns;
      bottomLine = undefined;
      try {
        const lines = originalRender.call(editor, columns - LEFT - RIGHT);
        const end = bottomLine === undefined ? -1 : lines.indexOf(bottomLine, 1);
        if (end < 1) {
          // A later extension changed native layout. Do not guess at its body.
          outerWidth = undefined;
          return originalRender.call(editor, columns);
        }
        const result = lines.map((line, index) => {
          if (index === 0 || index === end) return fit(line, columns);
          if (index > end) return fit(" ".repeat(LEFT) + line + " ".repeat(RIGHT), columns);
          const prompt = index === 1 ? info().accent("❯ ") : "  ";
          return fit(border("│ ") + prompt + line + border(" │"), columns);
        });
        framed = true;
        return result;
      } finally {
        outerWidth = undefined;
      }
    },
    handleMouse(event: Parameters<NonNullable<EditorComponent["handleMouse"]>>[0]) {
      if (!active) return originalMouse.call(editor, event);
      if (!framed) return originalMouse.call(editor, { ...event, width: Math.max(4, event.width) });
      return originalMouse.call(editor, {
        ...event,
        x: Math.max(0, event.x - LEFT),
        width: event.width - LEFT - RIGHT,
      });
    },
  };
  for (const name of names) Object.defineProperty(editor, name, { configurable: true, writable: true, value: methods[name] });
  return () => {
    active = false;
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      // Never remove a subsequent extension's replacement.
      if (Reflect.get(editor, name) !== methods[name]) continue;
      const descriptor = descriptors[i];
      if (descriptor) Object.defineProperty(editor, name, descriptor);
      else Reflect.deleteProperty(editor, name);
    }
  };
}

/** One public factory slot; compose an existing native editor, never its input. */
export function registerEditorStyle(pi: ExtensionAPI, style: TidyConfig["editorStyle"]): void {
  if (style !== "quiet") return;
  let factory: EditorFactory | undefined;
  let previous: EditorFactory | undefined;
  let context: ExtensionContext | undefined;
  let requestRender: (() => void) | undefined;
  let restoreEditor: (() => void) | undefined;
  let deactivateFactory: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    if (typeof ctx.ui.getEditorComponent !== "function" || typeof ctx.ui.setEditorComponent !== "function") {
      ctx.ui.notify("pi-tidy: quiet editor needs Pi's public editor factory API (tested with Pi 1.4.0).", "warning");
      return;
    }
    context = ctx;
    // A later extension may have wrapped/replaced us. Never take the slot back.
    if (factory) return;
    previous = ctx.ui.getEditorComponent();
    const inheritedFactory = previous;
    const lifetime = { active: true };
    deactivateFactory = () => { lifetime.active = false; };
    factory = (tui, theme, keybindings) => {
      const editor = inheritedFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      if (!lifetime.active) return editor;
      restoreEditor?.();
      requestRender = () => tui.requestRender();
      restoreEditor = decorateQuietEditor(editor, () => {
        const current = context!;
        return {
          model: current.model?.name || current.model?.id || "No model",
          thinking: pi.getThinkingLevel(),
          muted: (text) => current.ui.theme.fg("muted", text),
          accent: (text) => current.ui.theme.fg("accent", text),
        };
      });
      if (!restoreEditor) {
        ctx.ui.notify("pi-tidy: this custom editor has its own layout; quiet styling was skipped to preserve its editing behavior.", "warning");
      }
      return editor;
    };
    ctx.ui.setEditorComponent(factory);
  });
  const update = (_event: unknown, ctx: ExtensionContext) => {
    if (!context) return;
    context = ctx;
    requestRender?.();
  };
  pi.on("model_select", update);
  pi.on("thinking_level_select", update);
  pi.on("session_shutdown", (_event, ctx) => {
    deactivateFactory?.();
    deactivateFactory = undefined;
    restoreEditor?.();
    restoreEditor = undefined;
    if (factory && ctx.ui.getEditorComponent?.() === factory) ctx.ui.setEditorComponent(previous);
    factory = previous = undefined;
    context = undefined;
    requestRender = undefined;
  });
}
