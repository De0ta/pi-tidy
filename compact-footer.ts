/** Quiet-style footer: native identity and live extension statuses, exactly one row. */
import { isAbsolute, relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TidyConfig } from "./config.ts";

export interface CompactFooterInfo {
  cwd: string;
  home?: string;
  branch: string | null;
  session?: string;
  statuses: ReadonlyMap<string, string>;
  dim(text: string): string;
}

function plain(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

/** Match native Pi: home-relative path, optional (branch), optional • session. */
export function workspaceIdentity(info: Pick<CompactFooterInfo, "cwd" | "home" | "branch" | "session">): string {
  let cwd = info.cwd;
  if (info.home) {
    const fromHome = relative(info.home, cwd);
    if (!isAbsolute(fromHome) && fromHome !== ".." && !fromHome.startsWith(`..${sep}`)) {
      cwd = fromHome ? `~${sep}${fromHome}` : "~";
    }
  }
  if (info.branch) cwd += ` (${info.branch})`;
  if (info.session) cwd += ` • ${info.session}`;
  return plain(cwd);
}

/** Keep extension SGR colors, but never allow a status to create another row. */
function statusText(text: string): string {
  return text.split(/(\x1b\[[0-9;:]*m)/g)
    .map((part) => /^\x1b\[[0-9;:]*m$/.test(part) ? part : stripTerminalSequences(part).replace(/[\x00-\x1f\x7f-\x9f]/g, " "))
    .join("").replace(/\s+/g, " ").trim();
}

export function renderCompactFooter(info: CompactFooterInfo, width: number): string[] {
  const columns = Math.max(0, Math.floor(width));
  if (!columns) return [""];
  const identity = workspaceIdentity(info);
  // Quota gets first claim on the finite status budget, then all other keys.
  const statuses = [...info.statuses].sort(([a], [b]) => {
    if (a === b) return 0;
    if (a === "subscription-usage") return -1;
    if (b === "subscription-usage") return 1;
    return a.localeCompare(b);
  }).map(([, text]) => statusText(text)).filter((text) => visibleWidth(text) > 0);
  const status = statuses.join(info.dim(" · "));
  const ellipsis = info.dim("...");
  if (!status || columns < 8) return [truncateToWidth(info.dim(identity), columns, ellipsis)];

  // Keep a native-looking identity on the left and statuses on the right.
  // Narrow windows clip, never wrap; the workspace keeps at least 40%.
  const minimumIdentity = Math.min(visibleWidth(identity), Math.max(4, Math.floor(columns * 0.4)));
  const statusBudget = Math.min(visibleWidth(status), Math.max(0, columns - minimumIdentity - 2));
  const left = truncateToWidth(info.dim(identity), columns - statusBudget - 2, ellipsis);
  const right = truncateToWidth(status, statusBudget, ellipsis);
  const gap = " ".repeat(Math.max(2, columns - visibleWidth(left) - visibleWidth(right)));
  return [left + gap + right + "\x1b[0m"];
}

/** setFooter has no getter: use dispose notifications to avoid clearing a later owner. */
export function registerCompactFooter(pi: ExtensionAPI, style: TidyConfig["editorStyle"]): void {
  if (style !== "quiet") return;
  type Installation = {
    active: boolean;
    context: ExtensionContext;
    owner?: object;
    requestRender?: () => void;
  };
  let installation: Installation | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    if (installation) {
      installation.context = ctx;
      return; // Never reclaim the slot from another footer extension.
    }
    if (typeof ctx.ui.setFooter !== "function") {
      ctx.ui.notify("pi-tidy: the compact quiet footer needs Pi's public setFooter API.", "warning");
      return;
    }
    const state: Installation = { active: true, context: ctx };
    installation = state;
    ctx.ui.setFooter((tui, _theme, data) => {
      if (!state.active) return { render: () => [], invalidate() {} };
      const token = {};
      state.owner = token;
      const requestRender = () => { if (state.active && state.owner === token) tui.requestRender(); };
      state.requestRender = requestRender;
      const unsubscribe = data.onBranchChange(requestRender);
      let disposed = false;
      return {
        render(width) {
          if (disposed || !state.active) return [];
          const current = state.context;
          return renderCompactFooter({
            cwd: current.cwd,
            home: process.env.HOME || process.env.USERPROFILE,
            branch: data.getGitBranch(),
            session: pi.getSessionName(),
            statuses: data.getExtensionStatuses(),
            dim: (text) => current.ui.theme.fg("dim", text),
          }, width);
        },
        invalidate() {},
        dispose() {
          if (disposed) return;
          disposed = true;
          unsubscribe();
          if (state.owner === token) {
            state.owner = undefined;
            state.requestRender = undefined;
          }
        },
      };
    });
  });
  pi.on("session_info_changed", (_event, ctx) => {
    if (!installation) return;
    installation.context = ctx;
    installation.requestRender?.();
  });
  pi.on("session_shutdown", () => {
    const state = installation;
    installation = undefined;
    if (!state) return;
    state.active = false;
    if (state.owner) state.context.ui.setFooter(undefined);
  });
}
