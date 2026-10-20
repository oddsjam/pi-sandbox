/**
 * @oddsjam/pi-sandbox
 *
 * pi extension that wraps bash, read, write, and edit tools with the
 * @anthropic-ai/sandbox-runtime OS-level sandbox, with an interactive
 * permission prompt and a /sandbox-configure TUI wizard.
 *
 * Config storage (one user-level directory; no per-project files):
 *   ~/.pi/agent/sandbox/default.json   — fallback SandboxRuntimeConfig
 *   ~/.pi/agent/sandbox/projects.json  — { "<abs-project-path>": SandboxRuntimeConfig, ... }
 *
 * Project lookup is longest-prefix match on the canonicalized cwd. Neither
 * file is merged — the most specific match wins.
 *
 * Commands:
 *   /sandbox            — show the current effective configuration
 *   /sandbox-enable     — initialize the sandbox for this session
 *   /sandbox-disable    — fully tear down the sandbox for this session
 *   /sandbox-configure  — interactive TUI wizard to edit configs
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { homedir } from "node:os";

import { SandboxManager, type SandboxAskCallback } from "@anthropic-ai/sandbox-runtime";
import {
  createBashToolDefinition,
  isToolCallEventType,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { createSandboxedBashOps } from "./src/bash-ops.ts";
import {
  type SandboxConfig,
  appendDomain,
  appendReadPath,
  appendWritePath,
  applySessionOverlay,
  BUILTIN_DEFAULT_CONFIG,
  ensureDefaultConfig,
  findProjectKey,
  getConfigPaths,
  loadEffectiveBase,
  readDefault,
  readProjects,
  resolveProjectAppendKey,
  seedNewProjectEntry,
  validateConfig,
  writeDefault,
  writeProjects,
} from "./src/config.ts";
import { performDisable } from "./src/disable.ts";
import { createEnvTracker } from "./src/env.ts";
import {
  domainIsAllowed,
  extractDomainsFromCommand,
} from "./src/domains.ts";
import { extractBlockedWritePath } from "./src/output.ts";
import { canonicalizePath, isReadDenied, matchesPattern, resolveReadToolPath, resolveToolPath, shouldPromptForWrite } from "./src/paths.ts";
import {
  type PromptAction,
  type ProjectSituation,
  buildPromptOptions,
} from "./src/prompt.ts";
import { showPermissionPrompt } from "./src/prompt-ui.ts";
import { renderDisabledParts, renderStatus } from "./src/status.ts";
import { buildSummaryLines } from "./src/summary.ts";
import { attachTeardown } from "./src/teardown.ts";
import { runWizard } from "./src/wizard-ui.ts";

function createNetworkAskCallback(allowedDomains: readonly string[]): SandboxAskCallback {
  return async ({ host }) => domainIsAllowed(host, allowedDomains);
}

function isSupportedPlatform(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

export default function (pi: ExtensionAPI): void {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  const home = homedir();
  const paths = getConfigPaths(home);
  const localCwd = process.cwd();
  const userShellPath = SettingsManager.create(localCwd).getShellPath();
  const localBash = createBashToolDefinition(localCwd, { shellPath: userShellPath });

  // ── shared mutable state ────────────────────────────────────────────────────

  const flags = {
    enabled: { value: true },
    initialized: { value: false },
  };

  const unavailableReason = "Sandbox unavailable: tools are blocked. Use /sandbox to repair the config or explicitly disable protection.";

  const session = {
    domains: [] as string[],
    readPaths: [] as string[],
    writePaths: [] as string[],
  };

  const env = createEnvTracker();

  // Teardown handle is set once the sandbox is first initialized.
  let teardownHandle: ReturnType<typeof attachTeardown> | null = null;

  // ── effective config helpers ───────────────────────────────────────────────

  function loadEffective(cwd: string): { base: Partial<SandboxConfig>; projectKey: string | null; effective: Partial<SandboxConfig> } {
    const { base, projectKey } = loadEffectiveBase(cwd, home);
    const effective = applySessionOverlay(base, {
      domains: session.domains,
      readPaths: session.readPaths,
      writePaths: session.writePaths,
    });
    return { base, projectKey, effective };
  }

  // ── prompt builder ─────────────────────────────────────────────────────────

  function buildSituation(cwd: string): ProjectSituation {
    const canonical = canonicalizePath(cwd, home);
    const projects = readProjects(home);
    const match = findProjectKey(cwd, projects);
    if (match === null) return { kind: "none", cwd: canonical };
    if (match === canonical) return { kind: "exact", key: canonical };
    return { kind: "parent", parent: match, cwd: canonical };
  }

  function buildOptionsForCwd(cwd: string): ReturnType<typeof buildPromptOptions> {
    return buildPromptOptions({
      situation: buildSituation(cwd),
      defaultPath: paths.defaultPath,
      projectsPath: paths.projectsPath,
    });
  }

  // ── apply choices (writes config + reinitializes sandbox) ──────────────────

  type AllowKind = "domain" | "read" | "write";

  async function applyChoice(
    action: PromptAction,
    kind: AllowKind,
    value: string,
    cwd: string,
    ctx?: ExtensionContext,
  ): Promise<void> {
    // Session is always added; on top of any persistent write.
    if (kind === "domain" && !session.domains.includes(value)) session.domains.push(value);
    if (kind === "read" && !session.readPaths.includes(value)) session.readPaths.push(value);
    if (kind === "write" && !session.writePaths.includes(value)) session.writePaths.push(value);

    if (action.kind === "global") {
      const def = readDefault(home);
      const base = Object.keys(def).length === 0 ? BUILTIN_DEFAULT_CONFIG : def;
      let next: Partial<SandboxConfig> = base;
      if (kind === "domain") next = appendDomain(next, value);
      if (kind === "read") next = appendReadPath(next, value);
      if (kind === "write") next = appendWritePath(next, value);
      writeDefault(next, home);
    } else if (action.kind === "project-append") {
      const projects = readProjects(home);
      const existing = projects[action.targetKey];
      let next: Partial<SandboxConfig>;
      if (existing) {
        next = existing;
      } else {
        // No entry under this key yet — seed from default before mutating.
        const def = readDefault(home);
        next = structuredClone(Object.keys(def).length === 0 ? BUILTIN_DEFAULT_CONFIG : def);
      }
      if (kind === "domain") next = appendDomain(next, value);
      if (kind === "read") next = appendReadPath(next, value);
      if (kind === "write") next = appendWritePath(next, value);
      projects[action.targetKey] = next;
      writeProjects(projects, home);
    } else if (action.kind === "project-new") {
      // Create new entry seeded from parent (or default), then append.
      const projects = readProjects(home);
      const def = readDefault(home);
      const baseDefaults = Object.keys(def).length === 0 ? BUILTIN_DEFAULT_CONFIG : def;
      const parentKey = findProjectKey(cwd, projects);
      const seeded = seedNewProjectEntry(projects, baseDefaults, parentKey, action.targetKey);
      let entry: Partial<SandboxConfig> = seeded[action.targetKey] ?? {};
      if (kind === "domain") entry = appendDomain(entry, value);
      if (kind === "read") entry = appendReadPath(entry, value);
      if (kind === "write") entry = appendWritePath(entry, value);
      seeded[action.targetKey] = entry;
      writeProjects(seeded, home);
    }

    if (flags.initialized.value) await reinitialize(cwd, ctx);
  }

  // ── (re)initialize sandbox ─────────────────────────────────────────────────

  async function initSandbox(cwd: string, ctx?: ExtensionContext): Promise<boolean> {
    flags.enabled.value = true;
    flags.initialized.value = false;
    try {
      if (!isSupportedPlatform()) {
        ctx?.ui.notify(`Sandbox not supported on ${process.platform}`, "warning");
        return false;
      }
      const { effective } = loadEffective(cwd);
      if (!effective.network || !effective.filesystem) {
        ctx?.ui.notify("Sandbox config is incomplete (missing network or filesystem). Use /sandbox-configure.", "warning");
        return false;
      }
      const validation = validateConfig(effective);
      if (!validation.ok) {
        ctx?.ui.notify(`Sandbox config is invalid: ${validation.error}`, "error");
        return false;
      }
      await SandboxManager.initialize(
        {
          network: effective.network,
          filesystem: effective.filesystem,
          ignoreViolations: effective.ignoreViolations,
          enableWeakerNestedSandbox: effective.enableWeakerNestedSandbox,
          enableWeakerNetworkIsolation: effective.enableWeakerNetworkIsolation ?? true,
          ripgrep: effective.ripgrep,
          mandatoryDenySearchDepth: effective.mandatoryDenySearchDepth,
          allowPty: effective.allowPty,
          seccomp: effective.seccomp,
          bwrapPath: effective.bwrapPath,
          socatPath: effective.socatPath,
        },
        createNetworkAskCallback(effective.network.allowedDomains ?? []),
      );

      // Make Node's built-in fetch honour HTTP_PROXY env vars in this process
      // and any child Node processes that inherit the environment.
      const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
      if (nodeMajor !== undefined && nodeMinor !== undefined) {
        const supportsEnvProxy = (nodeMajor === 22 && nodeMinor >= 21) || nodeMajor >= 24;
        if (supportsEnvProxy && process.env.NODE_USE_ENV_PROXY === undefined) {
          env.set("NODE_USE_ENV_PROXY", "1");
        }
      }

      flags.enabled.value = true;
      flags.initialized.value = true;

      // Attach process-level teardown handlers once.
      if (!teardownHandle) {
        teardownHandle = attachTeardown({
          process: process as unknown as Parameters<typeof attachTeardown>[0]["process"],
          teardown: async () => {
            try {
              await SandboxManager.reset();
            } catch {
              // best-effort
            }
          },
        });
      }

      return true;
    } catch (err) {
      ctx?.ui.notify(
        `Sandbox initialization failed: ${err instanceof Error ? err.message : err}`,
        "error",
      );
      return false;
    }
  }

  /**
   * Tear down + restart the OS-level sandbox so freshly-added domains or
   * paths take effect for the next bash subprocess. Pass `ctx` to surface
   * failures through the TUI (`console.error` would corrupt the redrawn
   * TUI buffer, so we route through `ctx.ui.notify` instead).
   */
  async function reinitialize(cwd: string, ctx?: ExtensionContext): Promise<void> {
    if (!flags.enabled.value) return;
    flags.initialized.value = false;
    try {
      await SandboxManager.reset();
      await initSandbox(cwd, ctx);
    } catch (e) {
      ctx?.ui.notify(
        `Sandbox reinitialize failed: ${e instanceof Error ? e.message : e}`,
        "error",
      );
    } finally {
      if (ctx) updateStatus(ctx);
    }
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (flags.enabled.value) {
      if (!flags.initialized.value) {
        ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("error", "Sandbox: unavailable (tools blocked)"));
        return;
      }
      const { effective } = loadEffective(ctx.cwd);
      ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", renderStatus(effective)));
      return;
    }
    const { prefix, state } = renderDisabledParts();
    ctx.ui.setStatus("sandbox", `${prefix}${ctx.ui.theme.fg("error", state)}`);
  }

  async function fullDisable(ctx?: ExtensionContext): Promise<void> {
    const handle = teardownHandle ?? {
      detach: () => {},
      isDone: () => true,
    };
    const result = await performDisable({
      resetSandbox: () => SandboxManager.reset(),
      session,
      flags,
      env,
      teardown: handle,
    });
    teardownHandle = null;
    if (result.resetError) {
      ctx?.ui.notify(
        `Sandbox reset warning: ${result.resetError instanceof Error ? result.resetError.message : result.resetError}`,
        "warning",
      );
    }
    if (ctx) {
      updateStatus(ctx);
    }
  }

  // ── prompt helpers ──────────────────────────────────────────────────────────

  async function promptAndApply(
    ctx: ExtensionContext,
    title: string,
    kind: AllowKind,
    value: string,
  ): Promise<"allowed" | "blocked"> {
    const options = buildOptionsForCwd(ctx.cwd);
    const action = await showPermissionPrompt(ctx, title, options);
    if (action.kind === "abort") return "blocked";
    await applyChoice(action, kind, value, ctx.cwd, ctx);
    if (flags.enabled.value && !flags.initialized.value) return "blocked";
    return "allowed";
  }

  // ── event hooks ─────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const noSandbox = pi.getFlag("no-sandbox") as boolean;
    if (noSandbox) {
      await fullDisable();
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      updateStatus(ctx);
      return;
    }

    // First-time setup: seed default.json if missing.
    ensureDefaultConfig(home);

    const { base } = loadEffective(ctx.cwd);
    if (base.enabled === false) {
      await fullDisable();
      ctx.ui.notify("Sandbox disabled via config (enabled: false)", "info");
      updateStatus(ctx);
      return;
    }

    await initSandbox(ctx.cwd, ctx);
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    await fullDisable();
  });

  // ── tool_call hook ─────────────────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (!flags.enabled.value) return;
    if (!flags.initialized.value) return { block: true, reason: unavailableReason };
    const { effective } = loadEffective(ctx.cwd);

    // Network pre-check for bash
    if (flags.initialized.value && isToolCallEventType("bash", event)) {
      const domains = extractDomainsFromCommand(event.input.command);
      const allowed = effective.network?.allowedDomains ?? [];
      for (const domain of domains) {
        if (!domainIsAllowed(domain, allowed)) {
          const status = await promptAndApply(
            ctx,
            `🌐 Network blocked: "${domain}" is not in allowedDomains`,
            "domain",
            domain,
          );
          if (status === "blocked") {
            return {
              block: true,
              reason: `Network access to "${domain}" is blocked (not in allowedDomains).`,
            };
          }
        }
      }
    }

    if (isToolCallEventType("read", event)) {
      const filePath = canonicalizePath(resolveReadToolPath(event.input.path, localCwd, home), home);
      const allowRead = effective.filesystem?.allowRead ?? [];
      const denyRead = effective.filesystem?.denyRead ?? [];
      if (isReadDenied(filePath, denyRead, allowRead, home)) {
        return { block: true, reason: `Sandbox: read access denied for "${filePath}" (in denyRead).` };
      }
      if (!matchesPattern(filePath, allowRead, home)) {
        const status = await promptAndApply(
          ctx,
          `📖 Read blocked: "${filePath}" is not in allowRead`,
          "read",
          filePath,
        );
        if (status === "blocked") {
          return { block: true, reason: `Sandbox: read access denied for "${filePath}"` };
        }
      }
    }

    // Write/edit — denyWrite is hard-blocked; otherwise prompt if not in allowWrite.
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const path = canonicalizePath(resolveToolPath((event.input as { path: string }).path, localCwd, home), home);
      const allowWrite = effective.filesystem?.allowWrite ?? [];
      const denyWrite = effective.filesystem?.denyWrite ?? [];

      if (matchesPattern(path, denyWrite, home)) {
        return {
          block: true,
          reason:
            `Sandbox: write access denied for "${path}" (in denyWrite). ` +
            `To change this, edit denyWrite via /sandbox-configure (default.json or your project entry).`,
        };
      }

      if (shouldPromptForWrite(path, allowWrite, home)) {
        const status = await promptAndApply(
          ctx,
          `📝 Write blocked: "${path}" is not in allowWrite`,
          "write",
          path,
        );
        if (status === "blocked") {
          return { block: true, reason: `Sandbox: write access denied for "${path}" (not in allowWrite)` };
        }
      }
    }
    return undefined;
  });

  // ── user_bash (network pre-check for !cmd) ─────────────────────────────────

  pi.on("user_bash", async (event, ctx) => {
    if (!flags.enabled.value) return;
    if (!flags.initialized.value) {
      return {
        result: { output: unavailableReason, exitCode: 1, cancelled: false, truncated: false },
      };
    }
    const { effective } = loadEffective(ctx.cwd);
    const domains = extractDomainsFromCommand(event.command);
    const allowed = effective.network?.allowedDomains ?? [];
    for (const domain of domains) {
      if (!domainIsAllowed(domain, allowed)) {
        const status = await promptAndApply(
          ctx,
          `🌐 Network blocked: "${domain}" is not in allowedDomains`,
          "domain",
          domain,
        );
        if (status === "blocked") {
          return {
            result: {
              output: `Blocked: "${domain}" is not in allowedDomains. Use /sandbox-configure to review your config.`,
              exitCode: 1,
              cancelled: false,
              truncated: false,
            },
          };
        }
      }
    }
    return { operations: createSandboxedBashOps(userShellPath) };
  });

  // ── bash tool override with retry-after-allow ──────────────────────────────

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      const runBash = (): Promise<AgentToolResult<any>> => {
        if (!flags.enabled.value) {
          return localBash.execute(id, params, signal, onUpdate, ctx);
        }
        if (!flags.initialized.value) throw new Error(unavailableReason);
        const sandboxedBash = createBashToolDefinition(localCwd, {
          operations: createSandboxedBashOps(userShellPath),
          shellPath: userShellPath,
        });
        return sandboxedBash.execute(id, params, signal, onUpdate, ctx);
      };

      let result: AgentToolResult<any>;
      try {
        result = await runBash();
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes("Operation not permitted")) throw e;
        result = {
          content: [
            { type: "text", text: `Error: Command failed with OS-level sandbox restriction: ${e.message}` },
          ],
          details: {},
        };
      }

      // Post-execution retry — ONLY when actually sandboxed.
      // This is the bug-fix point from pi-sandbox: the original could trigger
      // a prompt on output containing "Operation not permitted" even if the
      // sandbox wasn't active. We require BOTH flags, plus a UI to prompt on.
      if (flags.enabled.value && flags.initialized.value && ctx?.hasUI) {
        const outputText = result.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        const blockedPath = extractBlockedWritePath(outputText);
        if (blockedPath) {
          const status = await promptAndApply(
            ctx,
            `📝 Write blocked: "${blockedPath}" is not in allowWrite`,
            "write",
            blockedPath,
          );
          if (status === "allowed") {
            // Re-check denyWrite — granting allowWrite doesn't override denyWrite.
            const { effective } = loadEffective(ctx.cwd);
            if (matchesPattern(blockedPath, effective.filesystem?.denyWrite ?? [], home)) {
              ctx.ui.notify(
                `⚠️ "${blockedPath}" was added to allowWrite, but it's also in denyWrite and remains blocked.`,
                "warning",
              );
              return result;
            }
            onUpdate?.({
              content: [{ type: "text", text: `\n--- Write access granted for "${blockedPath}", retrying ---\n` }],
              details: {},
            });
            return runBash();
          }
        }
      }

      return result;
    },
  });

  // ── commands ───────────────────────────────────────────────────────────────

  // /sandbox is the single inspection + configure + toggle command. It
  // opens the wizard with the current effective-config summary rendered
  // above the scope picker, plus a "Disable sandbox" / "Enable sandbox" row
  // as the first selectable option. Hitting Enter immediately at the menu
  // toggles the sandbox state without entering the editor; arrow down past
  // it to edit a project or the default config.
  pi.registerCommand("sandbox", {
    description: "Inspect, toggle, or configure the sandbox",
    handler: async (_args, ctx) => {
      const { base, projectKey, effective } = loadEffective(ctx.cwd);
      const summary = buildSummaryLines({
        enabled: flags.enabled.value,
        projectKey,
        defaultPath: paths.defaultPath,
        projectsPath: paths.projectsPath,
        base,
        effective,
        session,
      });

      const isEnabled = flags.enabled.value;
      const result = await runWizard(
        ctx,
        { cwd: ctx.cwd, home, paths },
        {
          summary,
          leadActions: [
            {
              id: "toggle",
              label: isEnabled ? "Disable sandbox" : "Enable sandbox",
              hint: isEnabled
                ? "Tear down the OS-level sandbox and clear session allowances"
                : "Initialize the OS-level sandbox for this session",
              emphasis: isEnabled ? "error" : "success",
            },
          ],
        },
      );

      if (result.kind === "lead-action" && result.id === "toggle") {
        if (isEnabled) {
          await fullDisable(ctx);
          ctx.ui.notify("Sandbox disabled", "info");
        } else {
          const ok = await initSandbox(ctx.cwd, ctx);
          updateStatus(ctx);
          if (ok) {
            ctx.ui.notify("Sandbox enabled", "info");
          }
        }
        return;
      }

      // Editor flow (or cancelled). Re-apply config so any edits take effect.
      if (flags.enabled.value) await reinitialize(ctx.cwd, ctx);
      updateStatus(ctx);
    },
  });
}
