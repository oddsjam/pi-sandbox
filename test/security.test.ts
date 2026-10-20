import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createReadToolDefinition, SettingsManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ExtensionHandler, type SessionStartEvent, type ToolCallEvent, type ToolCallEventResult, type ToolDefinition, type UserBashEvent, type UserBashEventResult } from "@earendil-works/pi-coding-agent";

import extension from "../index.ts";
import { BUILTIN_DEFAULT_CONFIG, type SandboxConfig, writeDefault } from "../src/config.ts";

let home: string;
let workspace: string;
let ctx: ExtensionContext;
let startHandler: ExtensionHandler<SessionStartEvent>;
let shutdown: () => Promise<void>;
let toolCall: ExtensionHandler<ToolCallEvent, ToolCallEventResult>;
let userBash: ExtensionHandler<UserBashEvent, UserBashEventResult>;
let command: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
let bash: ToolDefinition;
let noSandbox: boolean;
let status: string;
let initialize: ReturnType<typeof spyOn<typeof SandboxManager, "initialize">>;
let reset: ReturnType<typeof spyOn<typeof SandboxManager, "reset">>;
let restoreHome: ReturnType<typeof spyOn<typeof os, "homedir">>;
let restoreSettings: ReturnType<typeof spyOn<typeof SettingsManager, "create">>;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(os.tmpdir(), "pi-sandbox-security-")));
  workspace = join(home, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(home, ".pi", "agent", "mcp-oauth"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "auth.json"), "synthetic credential fixture");
  writeFileSync(join(home, ".pi", "agent", "mcp-oauth", "fixture.json"), "synthetic OAuth fixture");
  noSandbox = false;
  status = "";
  restoreHome = spyOn(os, "homedir").mockReturnValue(home);
  restoreSettings = spyOn(SettingsManager, "create").mockReturnValue(SettingsManager.inMemory());
  initialize = spyOn(SandboxManager, "initialize").mockResolvedValue(undefined);
  reset = spyOn(SandboxManager, "reset").mockResolvedValue(undefined);

  const ui = {
    notify() {},
    setStatus(_key: string, value: string) { status = value; },
    theme: { fg(_color: string, value: string) { return value; } },
  };
  ctx = { cwd: workspace, hasUI: false, ui } as unknown as ExtensionContext;
  const api = {
    registerFlag() {},
    getFlag() { return noSandbox; },
    on(event: string, handler: unknown) {
      if (event === "session_start") startHandler = handler as typeof startHandler;
      if (event === "session_shutdown") shutdown = handler as typeof shutdown;
      if (event === "tool_call") toolCall = handler as typeof toolCall;
      if (event === "user_bash") userBash = handler as typeof userBash;
    },
    registerTool(tool: ToolDefinition) { bash = tool; },
    registerCommand(_name: string, definition: { handler: typeof command }) { command = definition.handler; },
  };
  extension(api as unknown as ExtensionAPI);
  saveConfig();
});

afterEach(async () => {
  await shutdown();
  initialize.mockRestore();
  reset.mockRestore();
  restoreHome.mockRestore();
  restoreSettings.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

function saveConfig(overrides: Partial<SandboxConfig> = {}): void {
  writeDefault({
    ...BUILTIN_DEFAULT_CONFIG,
    filesystem: {
      ...BUILTIN_DEFAULT_CONFIG.filesystem,
      denyRead: [home, "~/.pi/agent/auth.json", "~/.pi/agent/mcp-oauth"],
      allowRead: [workspace, process.cwd(), "~/.pi"],
      allowWrite: [workspace],
    },
    ...overrides,
  }, home);
}

async function read(path: string): Promise<ToolCallEventResult | void> {
  return toolCall({ type: "tool_call", toolName: "read", toolCallId: "read-fixture", input: { path } }, ctx);
}

function start(event: Pick<SessionStartEvent, "type">, context: ExtensionContext): Promise<void> | void {
  return startHandler({ ...event, reason: "startup" }, context);
}

async function toggle(): Promise<void> {
  const custom = async () => ({ kind: "lead-action", id: "toggle" });
  await command("", { ...ctx, hasUI: true, ui: { ...ctx.ui, custom } } as unknown as ExtensionCommandContext);
}

describe("native read credential protection", () => {
  test("blocks auth.json despite its allowed parent", async () => {
    await start({ type: "session_start" }, ctx);
    expect((await read("~/.pi/agent/auth.json"))?.block).toBe(true);
  });

  test("blocks credentials within the denied OAuth directory", async () => {
    await start({ type: "session_start" }, ctx);
    expect((await read("~/.pi/agent/mcp-oauth/fixture.json"))?.block).toBe(true);
  });

  test("blocks a workspace symlink to auth.json", async () => {
    symlinkSync(join(home, ".pi", "agent", "auth.json"), join(workspace, "linked-auth"));
    await start({ type: "session_start" }, ctx);
    expect((await read(join(workspace, "linked-auth")))?.block).toBe(true);
  });

  test("blocks Pi's @ prefix alias to auth.json", async () => {
    await start({ type: "session_start" }, ctx);
    expect((await read("@~/.pi/agent/auth.json"))?.block).toBe(true);
  });

  test("blocks Pi's @ prefix alias to an absolute OAuth path", async () => {
    await start({ type: "session_start" }, ctx);
    expect((await read(`@${join(home, ".pi", "agent", "mcp-oauth", "fixture.json")}`))?.block).toBe(true);
  });

  test("allows ordinary Pi resources under a broadly denied home", async () => {
    await start({ type: "session_start" }, ctx);
    expect(await read("~/.pi/agent/skills/example/SKILL.md")).toBeUndefined();
  });

  test("allows Pi resources through the @ prefix alias", async () => {
    await start({ type: "session_start" }, ctx);
    expect(await read("@~/.pi/agent/skills/example/SKILL.md")).toBeUndefined();
  });

  for (const { input, target } of [
    { input: "Screenshot 1 PM.txt", target: "Screenshot 1\u202FPM.txt" },
    { input: "caf\u00e9.txt", target: "cafe\u0301.txt" },
    { input: "user's.txt", target: "user\u2019s.txt" },
    { input: "caf\u00e9's.txt", target: "cafe\u0301\u2019s.txt" },
    { input: "secret\u00a0file.txt", target: "secret file.txt" },
  ]) {
    test(`denies the same synthetic file Pi reads for ${JSON.stringify(input)}`, async () => {
      const targetPath = join(workspace, target);
      const inputPath = join(workspace, input);
      writeFileSync(targetPath, "synthetic filename fixture");
      saveConfig({ filesystem: { ...BUILTIN_DEFAULT_CONFIG.filesystem, allowRead: [workspace], denyRead: [targetPath] } });
      await start({ type: "session_start" }, ctx);
      const nativeResult = await createReadToolDefinition(workspace).execute("native-read", { path: inputPath }, undefined, undefined, ctx);
      expect(nativeResult.content.some((part) => part.type === "text" && part.text.includes("synthetic filename fixture"))).toBe(true);
      expect((await read(inputPath))?.block).toBe(true);
    });
  }

  test("allows workspace files under a broadly denied home", async () => {
    await start({ type: "session_start" }, ctx);
    expect(await read(join(workspace, "source.ts"))).toBeUndefined();
  });

  test("does not confuse auth.json with auth.json.example", async () => {
    await start({ type: "session_start" }, ctx);
    expect(await read("~/.pi/agent/auth.json.example")).toBeUndefined();
  });

  test("blocks a wildcard secret deny inside the workspace", async () => {
    const filesystem = { ...BUILTIN_DEFAULT_CONFIG.filesystem, allowRead: [workspace], denyRead: [join(workspace, "*.secret")] };
    saveConfig({ filesystem });
    await start({ type: "session_start" }, ctx);
    expect((await read(join(workspace, "private.secret")))?.block).toBe(true);
  });
});

describe("sandbox failures block execution", () => {
  test("blocks all agent tools after initialization fails", async () => {
    initialize.mockRejectedValue(new Error("runtime unavailable"));
    await start({ type: "session_start" }, ctx);
    for (const toolName of ["read", "write", "edit", "bash", "custom-tool"]) {
      const result = await toolCall({ type: "tool_call", toolName, toolCallId: toolName, input: { path: join(workspace, "file"), command: "true" } }, ctx);
      expect(result?.block).toBe(true);
    }
  });

  test("direct bash cannot create a file after initialization fails", async () => {
    initialize.mockRejectedValue(new Error("runtime unavailable"));
    await start({ type: "session_start" }, ctx);
    const marker = join(workspace, "must-not-exist");
    await expect(bash.execute("bash-fixture", { command: `touch '${marker}'` }, undefined, undefined, ctx)).rejects.toThrow(/sandbox/i);
    expect(existsSync(marker)).toBe(false);
  });

  test("blocks user bash rather than falling back to normal execution", async () => {
    initialize.mockRejectedValue(new Error("runtime unavailable"));
    await start({ type: "session_start" }, ctx);
    const result = await userBash({ type: "user_bash", command: "true", excludeFromContext: false, cwd: workspace }, ctx);
    expect(result?.result?.exitCode).toBe(1);
    expect(result?.operations).toBeUndefined();
  });

  test("reports unavailable protection in the status line", async () => {
    initialize.mockRejectedValue(new Error("runtime unavailable"));
    await start({ type: "session_start" }, ctx);
    expect(status).toContain("blocked");
  });

  test("blocks tools when the config is incomplete", async () => {
    writeDefault({ enabled: true }, home);
    await start({ type: "session_start" }, ctx);
    expect((await read(join(workspace, "file")))?.block).toBe(true);
  });

  test("blocks tools while initialization is pending", async () => {
    let complete: (() => void) | undefined;
    initialize.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const pending = start({ type: "session_start" }, ctx);
    try {
      expect((await read(join(workspace, "file")))?.block).toBe(true);
    } finally {
      complete?.();
      await pending;
    }
  });

  test("failed reinitialization keeps tools blocked", async () => {
    await start({ type: "session_start" }, ctx);
    initialize.mockRejectedValue(new Error("restart failed"));
    await command("", { ...ctx, ui: { ...ctx.ui, custom: async () => null } } as unknown as ExtensionCommandContext);
    expect((await read(join(workspace, "file")))?.block).toBe(true);
    expect(status).toContain("blocked");
  });

  test("failed reset during reinitialization keeps tools blocked", async () => {
    await start({ type: "session_start" }, ctx);
    reset.mockRejectedValue(new Error("reset failed"));
    await command("", { ...ctx, ui: { ...ctx.ui, custom: async () => null } } as unknown as ExtensionCommandContext);
    expect((await read(join(workspace, "file")))?.block).toBe(true);
  });

  test("a permission grant cannot release a read when reinitialization fails", async () => {
    await start({ type: "session_start" }, ctx);
    initialize.mockRejectedValue(new Error("restart failed"));
    const custom = async () => ({ kind: "session" });
    const result = await toolCall({ type: "tool_call", toolName: "read", toolCallId: "outside", input: { path: join(home, "..", "outside-workspace") } }, { ...ctx, hasUI: true, ui: { ...ctx.ui, custom } } as ExtensionContext);
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(result?.block).toBe(true);
  });

  test("failed enable from an explicitly disabled session blocks tools", async () => {
    noSandbox = true;
    await start({ type: "session_start" }, ctx);
    initialize.mockRejectedValue(new Error("enable failed"));
    await toggle();
    expect((await read(join(workspace, "file")))?.block).toBe(true);
    expect(status).toContain("blocked");
  });

  test("explicit disable allows ordinary bash execution", async () => {
    await start({ type: "session_start" }, ctx);
    await toggle();
    const marker = join(workspace, "explicit-disable");
    await bash.execute("bash-fixture", { command: `touch '${marker}'` }, undefined, undefined, ctx);
    expect(existsSync(marker)).toBe(true);
    expect(await read("~/.pi/agent/auth.json")).toBeUndefined();
  });

  test("--no-sandbox explicitly bypasses protection", async () => {
    noSandbox = true;
    await start({ type: "session_start" }, ctx);
    expect(await read("~/.pi/agent/auth.json")).toBeUndefined();
    expect(await userBash({ type: "user_bash", command: "true", excludeFromContext: false, cwd: workspace }, ctx)).toBeUndefined();
  });

  test("enabled: false explicitly bypasses protection", async () => {
    saveConfig({ enabled: false });
    await start({ type: "session_start" }, ctx);
    expect(await read("~/.pi/agent/auth.json")).toBeUndefined();
  });

  test("the user can enable protection over a disabled startup config", async () => {
    saveConfig({ enabled: false });
    await start({ type: "session_start" }, ctx);
    await toggle();
    expect((await read("~/.pi/agent/auth.json"))?.block).toBe(true);
    expect(status).not.toContain("disabled");
  });

  test("repairing the runtime recovers from failed initialization", async () => {
    initialize.mockRejectedValue(new Error("runtime unavailable"));
    await start({ type: "session_start" }, ctx);
    initialize.mockResolvedValue(undefined);
    await command("", { ...ctx, ui: { ...ctx.ui, custom: async () => null } } as unknown as ExtensionCommandContext);
    expect(await read(join(workspace, "source.ts"))).toBeUndefined();
    expect((await read("~/.pi/agent/auth.json"))?.block).toBe(true);
    expect(status).not.toContain("blocked");
  });
});
