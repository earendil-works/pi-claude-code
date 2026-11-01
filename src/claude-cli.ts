import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { TurnRelay } from "./turn-relay.ts";
import { usageCreditsAllowed, usageCreditsChargeError, type RateLimitInfo } from "./billing.ts";
import { envFlagEnabled } from "./env.ts";
import type { DiscoveredClaudeModel } from "./model-catalog.ts";
import type {
  AnthropicStreamEvent,
  NativeFrame,
  NativeMessage,
  NativeOutputEvent,
  NativeResult,
  NativeUsage,
} from "./native-types.ts";
import { canonicalizeToolUseNames, type NativeSystemInjection, type ToolManifestEntry } from "./transcript.ts";

export const INSTALL_HINT =
  "Claude Code is not installed. Install it with `npm install -g @anthropic-ai/claude-code` " +
  "or set PI_CLAUDE_CODE_COMMAND to the executable.";
export const LOGIN_HINT = "Claude Code is installed but not logged in. Run `claude auth login` and try again.";

export interface ClaudeStatus {
  available: boolean;
  loggedIn: boolean;
  /** True when Claude Code reports a Claude Pro/Max-style subscription login. */
  subscription: boolean;
  authMethod?: string;
  plan?: string;
  detail?: string;
  command?: string;
}

export interface RunClaudeInput {
  model: string;
  /** Working directory exposed to Claude and used for Pi tool paths. */
  cwd?: string;
  frames: NativeFrame[];
  systemPrompt: string;
  manifest: ToolManifestEntry[];
  extraBody: Record<string, unknown>;
  toolNames: Set<string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  upstreamUrl?: string;
  /** Native blocks Claude Code injected ahead of the first canonical user message. */
  initialUserPrefix?: unknown[];
  /** Native system messages Claude Code injected immediately after that user message. */
  initialSystemMessages?: unknown[];
  /** Pi system/tool deltas to restore at their historical assistant boundaries. */
  nativeSystemInjections?: NativeSystemInjection[];
  /** Beta features appended to Claude Code's own request header by the turn relay. */
  betas?: string[];
  onEvent?: (event: AnthropicStreamEvent) => void;
  /** Pi session whose linear continuation may reuse a warm Claude process. */
  sessionId?: string;
  /** Hold events this long (unless a content block completes first) so an early cut can be retried. Default 1500. */
  deliveryBufferMs?: number;
  /** First retry delay; doubles per attempt. Default 1000. */
  retryBaseDelayMs?: number;
}

export interface RunClaudeOutput {
  message: NativeMessage;
  result: NativeResult;
  usage: NativeUsage;
  exitCode: number;
  relay: {
    upstreamRequests: number;
    blockedRequests: number;
    requestId?: string;
  };
  initialUserPrefix?: unknown[];
  initialSystemMessages?: unknown[];
  /** Latest plan-limit status Claude Code reported for this turn. */
  rateLimit?: RateLimitInfo;
}

function configuredCommand(env: Record<string, string | undefined>): string {
  return env.PI_CLAUDE_CODE_COMMAND || "claude";
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveClaudeExecutable(
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const command = configuredCommand(env);
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const candidate = resolve(command);
    return (await executable(candidate)) ? candidate : undefined;
  }

  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").flatMap((suffix) => [suffix, suffix.toLowerCase()])
      : [""];
  for (const directory of (env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    for (const suffix of extensions) {
      const candidate = join(directory, process.platform === "win32" && extname(command) ? command : command + suffix);
      if (await executable(candidate)) return candidate;
    }
  }
  return undefined;
}

function withConfigDirectory(env: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) output[key] = value;
  if (output.PI_CLAUDE_CODE_CONFIG_DIR) output.CLAUDE_CONFIG_DIR = output.PI_CLAUDE_CODE_CONFIG_DIR;
  return output;
}

async function captureProcess(
  command: string,
  args: string[],
  env: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  const child = spawnCommand(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (stdout = (stdout + chunk).slice(-1_000_000)));
  child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-65_536)));

  const abort = () => killProcessTree(child);
  let timedOut = false;
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);
  try {
    const code = await childExit(child).catch((error: unknown) => {
      signal?.throwIfAborted();
      if (timedOut) throw new Error(`timed out after ${timeoutMs}ms`);
      throw error;
    });
    signal?.throwIfAborted();
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function getClaudeStatus(
  envInput: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<ClaudeStatus> {
  const env = withConfigDirectory(envInput);
  const command = await resolveClaudeExecutable(env);
  if (!command) return { available: false, loggedIn: false, subscription: false, detail: INSTALL_HINT };
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await captureProcess(command, ["auth", "status"], env, signal, timeoutMs);
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { available: true, loggedIn: false, subscription: false, command, detail: authStatusFailure(message) };
  }
  let payload: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown } | undefined;
  let parsedJson = false;
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim());
    parsedJson = true;
    if (parsed && typeof parsed === "object" && typeof (parsed as { loggedIn?: unknown }).loggedIn === "boolean") {
      payload = parsed as typeof payload;
    }
  } catch {
    payload = undefined;
  }
  // Only a parsed `loggedIn: false` means "not logged in"; anything else is a
  // failed status check and reports the real error instead of LOGIN_HINT.
  if (!payload) {
    // JSON stdout may carry account details (email, org id): never echo it.
    const reason =
      result.code !== 0
        ? `exit code ${result.code}`
        : parsedJson
          ? "unexpected output (no loggedIn field)"
          : result.stdout.trim()
            ? "unparseable output"
            : "no output";
    const tail = (result.stderr.trim() || (parsedJson ? "" : result.stdout.trim())).slice(-500);
    return {
      available: true,
      loggedIn: false,
      subscription: false,
      command,
      detail: authStatusFailure(tail ? `${reason}: ${tail}` : reason),
    };
  }
  const loggedIn = payload.loggedIn === true;
  const plan = typeof payload.subscriptionType === "string" ? payload.subscriptionType : undefined;
  return {
    available: true,
    loggedIn,
    subscription: loggedIn && !!plan,
    command,
    authMethod: typeof payload.authMethod === "string" ? payload.authMethod : undefined,
    plan,
    detail: loggedIn ? undefined : LOGIN_HINT,
  };
}

function authStatusFailure(reason: string): string {
  return `claude auth status failed: ${reason}`;
}

const READY_STATUS_TTL_MS = 60_000;
const readyStatusCache = new Map<string, { command: string; expires: number }>();

/**
 * Resolve a logged-in Claude Code executable. Successful checks are cached
 * briefly because a fresh worker is spawned after every tool call, and an
 * extra `claude auth status` process on each of those turns adds latency.
 */
async function readyClaudeCommand(
  envInput: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<string> {
  const env = withConfigDirectory(envInput);
  const key = JSON.stringify([configuredCommand(env), env.PATH, env.HOME, env.CLAUDE_CONFIG_DIR]);
  const cached = readyStatusCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.command;

  const status = await getClaudeStatus(env, signal);
  if (!status.available || !status.command) throw new Error(INSTALL_HINT);
  if (!status.loggedIn) {
    readyStatusCache.delete(key);
    throw new Error(status.detail ?? LOGIN_HINT);
  }
  readyStatusCache.set(key, { command: status.command, expires: Date.now() + READY_STATUS_TTL_MS });
  return status.command;
}

function isDiscoveredModel(value: unknown): value is DiscoveredClaudeModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<DiscoveredClaudeModel>;
  return (
    typeof model.value === "string" &&
    typeof model.displayName === "string" &&
    typeof model.description === "string" &&
    (model.resolvedModel === undefined || typeof model.resolvedModel === "string")
  );
}

/** Ask the installed Claude Code process for the account's selectable model catalog. */
export async function discoverClaudeModels(
  envInput: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<DiscoveredClaudeModel[]> {
  signal?.throwIfAborted();
  const env = processEnvironment(envInput, {});
  const command = await resolveClaudeExecutable(env);
  if (!command) throw new Error(INSTALL_HINT);

  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "default",
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--no-session-persistence",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
  ];
  const child = spawnCommand(command, args, {
    cwd: process.cwd(),
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-65_536)));

  const abort = () => killProcessTree(child);
  signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, timeoutMs);

  const requestId = `pi-models-${Date.now()}`;
  child.stdin?.write(
    `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`,
  );
  child.stdin?.end(
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "model-catalog-probe" }] },
      shouldQuery: false,
    })}\n`,
  );

  let models: DiscoveredClaudeModel[] | undefined;
  try {
    const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type !== "control_response") continue;
      const envelope = event.response as Record<string, unknown> | undefined;
      if (envelope?.request_id !== requestId || envelope.subtype !== "success") continue;
      const response = envelope.response as Record<string, unknown> | undefined;
      if (Array.isArray(response?.models)) models = response.models.filter(isDiscoveredModel);
    }
    const exitCode = await childExit(child);
    signal?.throwIfAborted();
    if (timedOut) throw new Error("Claude Code model discovery timed out");
    if (exitCode !== 0) throw new Error(`Claude Code model discovery failed${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`);
    if (!models?.length) throw new Error("Claude Code returned no selectable models");
    return models;
  } catch (error) {
    if (timedOut) throw new Error("Claude Code model discovery timed out", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (child.exitCode === null) killProcessTree(child);
  }
}

function spawnCommand(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
): ChildProcess {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)) {
    const comspec = options?.env?.COMSPEC || process.env.COMSPEC || "cmd.exe";
    const quote = (value: string) => `"${value.replace(/"/gu, '""')}"`;
    return spawn(comspec, ["/d", "/s", "/c", [quote(command), ...args.map(quote)].join(" ")], options);
  }
  return spawn(command, args, options);
}

function childExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null) resolve(code);
      else reject(new Error(`Claude Code exited from signal ${signal ?? "unknown"}`));
    });
  });
}

export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // It exited between the checks.
    }
  }
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;
  private failure?: Error;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(error?: Error): void {
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async next(signal: AbortSignal | undefined, timeoutMs: number): Promise<T | undefined> {
    if (this.values.length) return this.values.shift();
    if (this.ended) {
      if (this.failure) throw this.failure;
      return undefined;
    }
    signal?.throwIfAborted();

    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        fn();
      };
      const waiter = (item: IteratorResult<T>) =>
        finish(() => {
          if (item.done && this.failure) reject(this.failure);
          else resolve(item.done ? undefined : item.value);
        });
      const onAbort = () => finish(() => reject(signal?.reason ?? new Error("Claude Code request aborted")));
      const timer = setTimeout(() => finish(() => reject(new Error("Claude Code stream timed out"))), timeoutMs);
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function conflictingEnvironment(env: Record<string, string>): string[] {
  const conflicts = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY"].filter(
    (key) => !!env[key],
  );
  for (const key of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
    if (envFlagEnabled(env[key])) conflicts.push(key);
  }
  return conflicts;
}

function processEnvironment(
  input: Record<string, string | undefined> | undefined,
  extraBody: Record<string, unknown>,
): Record<string, string> {
  const env = withConfigDirectory({ ...process.env, ...input });
  const conflicts = conflictingEnvironment(env);
  if (conflicts.length) {
    throw new Error(`Claude Code subscription provider refuses conflicting auth/backend overrides: ${conflicts.join(", ")}`);
  }
  delete env.CLAUDE_CODE_EXTRA_BODY;
  Object.assign(env, {
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_MAX_RETRIES: "0",
    DISABLE_AUTO_COMPACT: "1",
    DISABLE_COMPACT: "1",
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  });
  if (typeof extraBody.max_tokens === "number") env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(extraBody.max_tokens);
  return env;
}

async function writeFrame(child: ChildProcess, frame: NativeFrame): Promise<void> {
  if (!child.stdin?.writable) throw new Error("Claude Code stdin closed during history replay");
  if (!child.stdin.write(`${JSON.stringify(frame)}\n`)) {
    await new Promise<void>((resolve, reject) => {
      child.stdin!.once("drain", resolve);
      child.stdin!.once("error", reject);
    });
  }
}

function nativeErrorText(event: Extract<NativeOutputEvent, { type: "assistant" }>): string | undefined {
  const messageError = (event.message as Record<string, unknown>).error;
  if (!event.error && !messageError) return undefined;
  return event.message.content
    .filter((block): block is Extract<(typeof event.message.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "cache_control") output[key] = withoutCacheControl(child);
  }
  return output;
}

interface NativeRequestMessage {
  role?: string;
  content?: unknown;
}

function requestMessages(body: Buffer | undefined): NativeRequestMessage[] | undefined {
  if (!body) return undefined;
  try {
    const payload = JSON.parse(body.toString("utf8")) as { messages?: unknown };
    return Array.isArray(payload.messages) ? (payload.messages as NativeRequestMessage[]) : undefined;
  } catch {
    return undefined;
  }
}

function deriveInitialUserPrefix(body: Buffer | undefined, canonicalContent: unknown[]): unknown[] | undefined {
  if (canonicalContent.length === 0) return undefined;
  const actual = requestMessages(body)?.[0];
  if (actual?.role !== "user" || !Array.isArray(actual.content) || actual.content.length < canonicalContent.length) {
    return undefined;
  }
  const suffix = actual.content.slice(-canonicalContent.length).map(withoutCacheControl);
  if (JSON.stringify(suffix) !== JSON.stringify(canonicalContent.map(withoutCacheControl))) return undefined;
  return structuredClone(actual.content.slice(0, -canonicalContent.length));
}

function deriveInitialSystemMessages(body: Buffer | undefined): unknown[] | undefined {
  const messages = requestMessages(body);
  if (messages?.[0]?.role !== "user") return undefined;
  let end = 1;
  while (messages[end]?.role === "system") end += 1;
  const systems = messages.slice(1, end);

  // A replayed history from an older carrier has the date reminder at the
  // moving tail rather than in the initial environment reminder. Snapshot it
  // beside the environment so the next request has a stable prefix.
  let trailingStart = messages.length;
  while (trailingStart > end && messages[trailingStart - 1]?.role === "system") trailingStart -= 1;
  if (trailingStart < messages.length) systems.push(...messages.slice(trailingStart));
  return systems.length ? structuredClone(systems) : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string"
        ? ((block as Record<string, unknown>).text as string)
        : "",
    )
    .join("");
}

function setCacheBreakpoint(message: NativeRequestMessage): void {
  if (typeof message.content === "string") {
    message.content = [
      { type: "text", text: message.content, cache_control: { type: "ephemeral", ttl: "1h" } },
    ];
    return;
  }
  if (!Array.isArray(message.content) || message.content.length === 0) return;
  const last = message.content.at(-1);
  if (!last || typeof last !== "object") return;
  // One breakpoint per message: Claude Code may already have marked an earlier
  // block (e.g. a trailing date-reminder system message), and a second marker
  // here would exceed Anthropic's four-breakpoint limit.
  for (const block of message.content) {
    if (block && typeof block === "object") delete (block as Record<string, unknown>).cache_control;
  }
  (last as Record<string, unknown>).cache_control = { type: "ephemeral", ttl: "1h" };
}

function setReplayCacheBreakpoints(messages: NativeRequestMessage[]): void {
  const userIndexes = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  if (userIndexes.length >= 3) {
    // Claude permits four cache breakpoints. Its two system-prompt markers
    // consume half of them, so once a prior queried user exists, move the
    // native environment marker to that exact previous query boundary. This
    // avoids relying on automatic lookback (notably unreliable with images).
    for (const message of messages) {
      if (message.role === "system") message.content = withoutCacheControl(message.content);
    }
    setCacheBreakpoint(messages[userIndexes.at(-2)!]!);
  }
  const final = messages.at(-1);
  if (final) setCacheBreakpoint(final);
}

function removeRepeatedUserReminders(messages: NativeRequestMessage[], prefix: unknown[] | undefined): void {
  const reminder = contentText(prefix).trimEnd();
  if (!reminder || !prefix) return;
  const normalizedPrefix = JSON.stringify(prefix.map(withoutCacheControl));

  for (let index = 1; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    const leading = message.content.slice(0, prefix.length).map(withoutCacheControl);
    if (JSON.stringify(leading) === normalizedPrefix) message.content.splice(0, prefix.length);

    const toolResult = message.content.findLast(
      (block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result",
    ) as Record<string, unknown> | undefined;
    if (!toolResult) continue;

    const suffix = `\n${reminder}`;
    if (typeof toolResult.content === "string" && toolResult.content.endsWith(suffix)) {
      toolResult.content = toolResult.content.slice(0, -suffix.length);
    } else if (Array.isArray(toolResult.content)) {
      const final = toolResult.content.at(-1) as Record<string, unknown> | undefined;
      if (final?.type === "text" && typeof final.text === "string") {
        if (final.text === reminder) toolResult.content.pop();
        else if (final.text.endsWith(suffix)) final.text = final.text.slice(0, -suffix.length);
      }
    }
  }
}

function injectNativeSystemMessages(
  messages: NativeRequestMessage[],
  injections: NativeSystemInjection[],
): NativeRequestMessage[] {
  const byAssistant = new Map<number, NativeRequestMessage[]>();
  const trailing: NativeRequestMessage[] = [];
  for (const injection of injections) {
    const message = { role: "system", content: structuredClone(injection.content) };
    if (injection.beforeAssistant === null) trailing.push(message);
    else {
      const pending = byAssistant.get(injection.beforeAssistant) ?? [];
      pending.push(message);
      byAssistant.set(injection.beforeAssistant, pending);
    }
  }

  const output: NativeRequestMessage[] = [];
  let assistantOrdinal = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      output.push(...(byAssistant.get(assistantOrdinal) ?? []));
      byAssistant.delete(assistantOrdinal);
      assistantOrdinal += 1;
    }
    output.push(message);
  }
  if (byAssistant.size > 0) throw new Error("Claude Code request lost an assistant boundary needed by system history");
  output.push(...trailing);
  return output;
}

function normalizeLeadingSystemCache(system: unknown): void {
  if (!Array.isArray(system)) return;
  for (const block of system) {
    if (block && typeof block === "object") delete (block as Record<string, unknown>).cache_control;
  }
  const last = system.at(-1);
  if (last && typeof last === "object") {
    (last as Record<string, unknown>).cache_control = { type: "ephemeral", ttl: "1h" };
  }
}

const MAX_CACHE_BREAKPOINTS = 4;

function collectCacheMarkers(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const child of value) collectCacheMarkers(child, out);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.cache_control !== undefined) out.push(record);
    for (const [key, child] of Object.entries(record)) if (key !== "cache_control") collectCacheMarkers(child, out);
  }
}

/**
 * Anthropic rejects requests with more than four cache_control blocks ("Found 5").
 * Final pass over the outgoing request: keep tools/system prefix markers and the
 * latest message marker, dropping the oldest message markers first.
 */
export function capCacheBreakpoints(payload: { messages?: unknown; system?: unknown; tools?: unknown }): void {
  const fixed: Record<string, unknown>[] = [];
  collectCacheMarkers(payload.tools, fixed);
  collectCacheMarkers(payload.system, fixed);
  const inMessages: Record<string, unknown>[] = [];
  collectCacheMarkers(payload.messages, inMessages);
  let excess = fixed.length + inMessages.length - MAX_CACHE_BREAKPOINTS;
  for (let i = 0; excess > 0 && i < inMessages.length - 1; i++, excess--) delete inMessages[i]!.cache_control;
  // Prefix markers only go if even tools+system alone exceed the limit; drop the latest first.
  for (let i = fixed.length - 1; excess > 0 && i >= 0; i--, excess--) delete fixed[i]!.cache_control;
}

export function rewriteInitialRequest(
  body: Buffer,
  prefix: unknown[] | undefined,
  canonicalContent: unknown[],
  initialSystemMessages: unknown[] | undefined,
  nativeSystemInjections?: NativeSystemInjection[],
): Buffer {
  const payload = JSON.parse(body.toString("utf8")) as {
    messages?: NativeRequestMessage[];
    system?: unknown;
  };
  let messages = payload.messages;
  const first = messages?.[0];
  if (first?.role !== "user" || !Array.isArray(first.content)) {
    throw new Error("Claude Code request is missing its initial user message");
  }
  if (prefix) first.content = [...structuredClone(prefix), ...structuredClone(canonicalContent)];

  if (initialSystemMessages?.length && messages) {
    let systemEnd = 1;
    while (messages[systemEnd]?.role === "system") systemEnd += 1;
    messages.splice(1, systemEnd - 1, ...(structuredClone(initialSystemMessages) as NativeRequestMessage[]));

    const initialText = initialSystemMessages
      .map((message) => contentText((message as NativeRequestMessage).content))
      .join("\n");
    while (messages.at(-1)?.role === "system") {
      const trailingText = contentText(messages.at(-1)?.content);
      if (!trailingText || !initialText.includes(trailingText)) break;
      messages.pop();
    }
    removeRepeatedUserReminders(messages, prefix);
  }

  if (nativeSystemInjections) {
    messages = injectNativeSystemMessages(messages!, nativeSystemInjections);
    payload.messages = messages;
    normalizeLeadingSystemCache(payload.system);
  }
  if (initialSystemMessages?.length || nativeSystemInjections) setReplayCacheBreakpoints(messages!);
  capCacheBreakpoints(payload);

  return Buffer.from(JSON.stringify(payload));
}

const CLAUDE_PROCESS_MAX_AGE_MS = 5 * 60 * 1_000;
const MAX_CACHED_CLAUDE_PROCESSES = 2;

interface ClaudeLaunchPlan {
  env: Record<string, string>;
  fingerprint: string;
  timeoutMs: number;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function frameHistoryHash(frames: NativeFrame[]): string {
  return digest(
    frames.map((frame) => ({
      type: frame.type,
      message: frame.message,
    })),
  );
}

function launchPlan(input: RunClaudeInput): ClaudeLaunchPlan {
  const timeoutMs = input.timeoutMs ?? 180_000;
  const env = processEnvironment(input.env, input.extraBody);
  return {
    env,
    timeoutMs,
    fingerprint: digest({
      command: configuredCommand(env),
      cwd: resolve(input.cwd ?? process.cwd()),
      env,
      extraBody: input.extraBody,
      manifest: input.manifest,
      model: input.model,
      systemPrompt: input.systemPrompt,
      timeoutMs,
      upstreamUrl: input.upstreamUrl ?? "https://api.anthropic.com",
    }),
  };
}

class ClaudeProcess {
  busy = false;
  readonly createdAt = Date.now();
  lastUsed = this.createdAt;

  private tipHash?: string;
  private expiryTimer?: NodeJS.Timeout;
  private closed = false;
  private stderr = "";

  private constructor(
    readonly fingerprint: string,
    private readonly root: string,
    private readonly child: ChildProcess,
    private readonly relay: TurnRelay,
    private readonly queue: AsyncQueue<NativeOutputEvent>,
    private readonly readTask: Promise<void>,
    private readonly exitOutcome: Promise<{ code?: number; error?: Error }>,
    private readonly timeoutMs: number,
  ) {
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-65_536)));
  }

  static async create(input: RunClaudeInput, plan: ClaudeLaunchPlan): Promise<ClaudeProcess> {
    input.signal?.throwIfAborted();
    const command = await readyClaudeCommand({ ...process.env, ...input.env }, input.signal);

    const root = await mkdtemp(join(tmpdir(), "pi-claude-code-"));
    const toolsPath = join(root, "tools.json");
    const settingsPath = join(root, "settings.json");
    const systemPath = join(root, "system.md");
    const inertMcpPath = fileURLToPath(new URL("./inert-mcp.mjs", import.meta.url));
    let child: ChildProcess | undefined;
    let relay: TurnRelay | undefined;

    try {
      await Promise.all([
        writeFile(toolsPath, JSON.stringify(input.manifest), "utf8"),
        writeFile(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(input.extraBody) } }), "utf8"),
        writeFile(systemPath, input.systemPrompt, "utf8"),
      ]);

      relay = new TurnRelay(input.upstreamUrl ?? "https://api.anthropic.com", plan.timeoutMs);
      const env = { ...plan.env, ANTHROPIC_BASE_URL: await relay.start() };
      const mcp = {
        mcpServers: {
          pi: { command: process.execPath, args: [inertMcpPath, toolsPath] },
        },
      };
      const args = [
        "-p",
        "--model",
        input.model,
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--tools",
        "",
        "--system-prompt-file",
        systemPath,
        "--settings",
        settingsPath,
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--max-turns",
        "1",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "--mcp-config",
        JSON.stringify(mcp),
      ];

      child = spawnCommand(command, args, {
        // Claude Code tells the model its process cwd. Keep transport files
        // private while exposing Pi's real working directory to the model.
        cwd: input.cwd ?? process.cwd(),
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const queue = new AsyncQueue<NativeOutputEvent>();
      const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      const readTask = (async () => {
        try {
          for await (const line of reader) {
            if (!line.trim()) continue;
            try {
              queue.push(JSON.parse(line) as NativeOutputEvent);
            } catch (error) {
              throw new Error(`Invalid Claude Code stream-json output: ${line.slice(0, 300)}`, { cause: error });
            }
          }
          queue.end();
        } catch (error) {
          queue.end(error instanceof Error ? error : new Error(String(error)));
        }
      })();
      const exitOutcome = childExit(child).then(
        (code) => ({ code }),
        (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
      );
      return new ClaudeProcess(plan.fingerprint, root, child, relay, queue, readTask, exitOutcome, plan.timeoutMs);
    } catch (error) {
      relay?.abort();
      if (child && child.exitCode === null) killProcessTree(child);
      await relay?.close();
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  isAlive(): boolean {
    return !this.closed && this.child.exitCode === null && !!this.child.stdin?.writable;
  }

  isExpired(now = Date.now()): boolean {
    return now - this.createdAt >= CLAUDE_PROCESS_MAX_AGE_MS;
  }

  canContinue(input: RunClaudeInput): boolean {
    if (!this.tipHash || input.frames.length === 0) return false;
    return frameHistoryHash(input.frames.slice(0, -1)) === this.tipHash;
  }

  clearExpiryTimer(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  /** Mark the worker idle and schedule its close for the end of its lifetime. */
  armExpiryTimer(expire: () => void): void {
    this.clearExpiryTimer();
    this.lastUsed = Date.now();
    const remainingLifetime = CLAUDE_PROCESS_MAX_AGE_MS - (this.lastUsed - this.createdAt);
    this.expiryTimer = setTimeout(expire, Math.max(0, remainingLifetime));
    this.expiryTimer.unref?.();
  }

  commit(input: RunClaudeInput, message: NativeMessage): boolean {
    // Claude Code executes MCP calls internally before emitting its max-turns
    // result. Our inert MCP response is therefore part of its hidden history,
    // while Pi will append the real tool result. That state is not a faithful
    // continuation and must be discarded; the next request replays from Pi.
    if (message.content.some((block) => block.type === "tool_use")) {
      this.tipHash = undefined;
      return false;
    }
    this.tipHash = frameHistoryHash([
      ...input.frames,
      { type: "assistant", message: { role: "assistant", content: message.content } },
    ]);
    return true;
  }

  async run(input: RunClaudeInput, continuation: boolean): Promise<RunClaudeOutput> {
    if (!this.isAlive()) throw new Error("Claude Code process is no longer available");
    input.signal?.throwIfAborted();

    let sawMessageStop = false;
    // A throw from the consumer (e.g. the stream translator) is Pi's own failure, not an upstream cut: keep it so it
    // surfaces as itself instead of the relay's retryable "Incomplete Claude Code upstream response".
    let consumerError: { error: unknown } | undefined;
    const deliver = (event: AnthropicStreamEvent) => {
      if (event.type === "message_stop") sawMessageStop = true;
      try {
        input.onEvent?.(event);
      } catch (error) {
        consumerError ??= { error };
        throw error;
      }
    };
    const canonicalInitialUser = input.frames.find((frame) => frame.type === "user")?.message.content ?? [];
    this.relay.beginTurn(
      deliver,
      input.initialUserPrefix || input.initialSystemMessages || input.nativeSystemInjections
        ? (body) =>
            rewriteInitialRequest(
              body,
              input.initialUserPrefix,
              canonicalInitialUser,
              input.initialSystemMessages,
              input.nativeSystemInjections,
            )
        : undefined,
      input.betas,
    );

    const abort = () => {
      this.relay.abort();
      this.closeNow();
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    const assistants: NativeMessage[] = [];
    let result: NativeResult | undefined;
    let nativeError: string | undefined;
    let rateLimit: RateLimitInfo | undefined;
    const trace: string[] = [];

    try {
      const frames = continuation ? input.frames.slice(-1) : input.frames;
      for (const frame of frames) {
        await writeFrame(this.child, frame);
        if (frame.shouldQuery === false) {
          for (;;) {
            const event = await this.queue.next(input.signal, this.timeoutMs);
            if (!event) throw await this.exitError("Claude Code exited before acknowledging history replay");
            if (event.type === "result") {
              if (event.num_turns !== 0 || event.is_error) {
                throw new Error("Claude Code rejected zero-turn history replay");
              }
              break;
            }
          }
        }
      }

      for (;;) {
        const event = await this.queue.next(input.signal, this.timeoutMs);
        if (!event) throw await this.exitError("Claude Code exited before completing its response");
        if (trace.length < 12) trace.push(event.type === "result" ? `result:${event.subtype ?? "?"}${event.is_error ? "!" : ""}` : event.type);
        if (event.type === "assistant") {
          const error = nativeErrorText(event);
          if (error !== undefined) nativeError = error;
          else assistants.push(event.message);
        } else if (event.type === "result") {
          result = event;
          break;
        } else if (event.type === "rate_limit_event") {
          if (event.rate_limit_info && typeof event.rate_limit_info === "object") rateLimit = event.rate_limit_info;
        } else if (event.type === "stream_event" && !this.relay.used) {
          deliver(event.event);
        }
      }
      await this.relay.settled();
      input.signal?.throwIfAborted();
      if (consumerError) throw consumerError.error;

      let message: NativeMessage | undefined;
      if (this.relay.used) {
        if (this.relay.status !== 200 || !this.relay.capture.complete || !this.relay.capture.message) {
          let detail = `status ${this.relay.status ?? "unknown"}, capture ${this.relay.capture.complete ? "complete" : "incomplete"}`;
          if (this.relay.failure) detail += `, relay failure ${this.relay.failure}`;
          if (this.relay.denied) detail += `, native retries denied ${this.relay.denied}`;
          const upstreamError = this.relay.errorText();
          if (upstreamError) detail += `, upstream said: ${upstreamError.slice(0, 500)}`;
          throw new IncompleteClaudeResponse(`Incomplete Claude Code upstream response (${detail})`, {
            status: this.relay.status,
            upstreamError,
          });
        }
        message = this.relay.capture.message;
        sawMessageStop = true;
      } else {
        message = assistants.at(-1);
      }

      if (!message || !sawMessageStop || !result) {
        // Keep what the child actually said: a native API error text or an event trace is the only clue
        // when the response is incomplete (the bare message hid both in the 2026-10-26 loops).
        const clues = [
          nativeError ? `native error: ${nativeError.slice(0, 300)}` : "",
          this.stderr ? this.stderr.trim().slice(-500) : "",
          trace.length ? `events: ${trace.join(",")}` : "",
          `relay ${this.relay.used ? `used, status ${this.relay.status ?? "unknown"}` : "unused"}`,
        ].filter(Boolean);
        throw new IncompleteClaudeResponse(
          `Incomplete Claude Code response: assistant, message_stop and one result required (${clues.join("; ")})`,
        );
      }

      const nativeFailureHandled = this.relay.denied > 0 || message.stop_reason === "refusal";
      if (nativeError && !nativeFailureHandled) throw new Error(`Claude Code API error: ${nativeError}`);
      const hasTools = message.content.some((block) => block.type === "tool_use");
      const maxTurnsBoundary = hasTools && result.subtype === "error_max_turns";
      if (!maxTurnsBoundary && !nativeFailureHandled && (result.is_error || result.subtype !== "success")) {
        throw new Error(`Claude Code request failed: ${result.subtype ?? "unknown result"}`);
      }

      // A bare or re-cased name of a Pi tool is mapped to its declared name; an unknown one is left for Pi to
      // answer "Tool X not found" (a recoverable tool result), never a failed turn (2026-10-27 sonnet-5 sessions).
      canonicalizeToolUseNames(message, input.toolNames);

      const usage = message.usage ?? result.usage;
      if (!usage || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
        throw new Error("Claude Code response did not include complete token usage");
      }

      // The response is already charged at this point, but stopping here keeps
      // Pi's agent loop from issuing more requests against usage credits.
      if (rateLimit?.isUsingOverage === true && !usageCreditsAllowed({ ...process.env, ...input.env })) {
        throw usageCreditsChargeError(rateLimit);
      }

      return {
        message,
        result,
        usage,
        exitCode: this.child.exitCode ?? 0,
        relay: {
          upstreamRequests: Number(this.relay.used),
          blockedRequests: this.relay.denied,
          requestId: this.relay.requestId,
        },
        initialUserPrefix:
          input.initialUserPrefix ?? deriveInitialUserPrefix(this.relay.originalRequestBody, canonicalInitialUser),
        initialSystemMessages:
          input.initialSystemMessages ?? deriveInitialSystemMessages(this.relay.originalRequestBody),
        rateLimit,
      };
    } finally {
      input.signal?.removeEventListener("abort", abort);
      this.relay.finishTurn();
    }
  }

  async close(): Promise<void> {
    this.closeNow();
    await Promise.allSettled([this.readTask, this.exitOutcome, this.relay.close()]);
    await rm(this.root, { recursive: true, force: true });
  }

  private closeNow(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearExpiryTimer();
    this.relay.abort();
    if (this.child.exitCode === null) killProcessTree(this.child);
  }

  private async exitError(fallback: string): Promise<Error> {
    const outcome = await this.exitOutcome;
    if (outcome.error) return outcome.error;
    const detail = this.stderr.trim().slice(-500);
    return new Error(`${fallback} (exit ${outcome.code ?? "unknown"}${detail ? `: ${detail}` : ""})`);
  }
}

/** The child or relay ended without a complete response; the worker is unusable, a fresh one may succeed. */
export class IncompleteClaudeResponse extends Error {
  /** Upstream HTTP status seen by the relay, when the relay was used. */
  readonly status?: number;
  /** Upstream error text (HTTP error body or in-stream error event). */
  readonly upstreamError?: string;

  constructor(message: string, details: { status?: number; upstreamError?: string } = {}) {
    super(message);
    this.name = "IncompleteClaudeResponse";
    this.status = details.status;
    this.upstreamError = details.upstreamError;
  }
}

/** Attempts allowed per failure class: 429 gets one retry; overloaded, 5xx and stream cuts get two; other 4xx none. */
function maxAttemptsFor(error: IncompleteClaudeResponse): number {
  const status = error.status;
  if (status === 429 || /rate_limit_error/u.test(error.upstreamError ?? "")) return 2;
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) return 1;
  return 3;
}

/** Hold stream events until the first complete content block (or a time limit), so an early cut stays retryable. */
const DELIVERY_BUFFER_MS = 1_500;
const RETRY_BASE_DELAY_MS = 1_000;

class BufferedDelivery {
  flushed = false;
  sawToolUse = false;
  /** Set when the caller's onEvent threw during a timer-driven flush; the attempt is then aborted with it. */
  failure?: unknown;
  private readonly failed = new AbortController();
  /** Aborted (reason: the onEvent error) when a timer-driven flush fails; combined into the attempt's signal. */
  readonly signal = this.failed.signal;
  private pending: AnthropicStreamEvent[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly target: ((event: AnthropicStreamEvent) => void) | undefined,
    private readonly holdMs: number,
  ) {}

  readonly onEvent = (event: AnthropicStreamEvent): void => {
    if (event.type === "content_block_start" && event.content_block.type === "tool_use") this.sawToolUse = true;
    if (this.failed.signal.aborted) throw this.failure;
    if (!this.target) return;
    if (this.flushed) {
      this.target(event);
      return;
    }
    this.pending.push(event);
    if (event.type === "content_block_stop" || event.type === "message_stop") this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.timerFlush(), this.holdMs);
      this.timer.unref?.();
    }
  };

  flush(): void {
    this.cancelTimer();
    if (this.flushed || !this.target) return;
    this.flushed = true;
    const events = this.pending;
    this.pending = [];
    for (const event of events) this.target(event);
  }

  /** Rethrow a failure recorded by a timer-driven flush. */
  throwIfFailed(): void {
    if (this.failed.signal.aborted) throw this.failure;
  }

  /** Drop undelivered events of a failed attempt. */
  discard(): void {
    this.cancelTimer();
    this.pending = [];
  }

  // A throw here would escape as an uncaughtException: record it and abort the attempt instead.
  private timerFlush(): void {
    this.timer = undefined;
    try {
      this.flush();
    } catch (error) {
      this.failure = error;
      this.failed.abort(error);
    }
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Claude Code request aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface AcquiredProcess {
  worker: ClaudeProcess;
  retained: boolean;
  continuation: boolean;
  sessionId?: string;
}

const processCache = new Map<string, ClaudeProcess>();
let managerTail: Promise<void> = Promise.resolve();

async function withManagerLock<T>(operation: () => Promise<T> | T): Promise<T> {
  const previous = managerTail;
  let release!: () => void;
  managerTail = new Promise<void>((resolve) => (release = resolve));
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function expireProcess(sessionId: string, worker: ClaudeProcess): Promise<void> {
  const expired = await withManagerLock(() => {
    if (processCache.get(sessionId) !== worker || worker.busy || !worker.isExpired()) return false;
    processCache.delete(sessionId);
    return true;
  });
  if (expired) await worker.close();
}

/** Drop a worker from the warm cache (if it is still there) and close it. */
async function discardProcess(acquired: AcquiredProcess): Promise<void> {
  const { sessionId, worker } = acquired;
  if (sessionId && processCache.get(sessionId) === worker) {
    await withManagerLock(() => {
      if (processCache.get(sessionId) === worker) processCache.delete(sessionId);
    });
  }
  await worker.close();
}

async function acquireProcess(input: RunClaudeInput, plan: ClaudeLaunchPlan): Promise<AcquiredProcess> {
  return withManagerLock(async () => {
    const sessionId = input.sessionId;
    const cached = sessionId ? processCache.get(sessionId) : undefined;
    if (cached && !cached.busy) {
      cached.clearExpiryTimer();
      if (
        cached.isAlive() &&
        !cached.isExpired() &&
        cached.fingerprint === plan.fingerprint &&
        cached.canContinue(input)
      ) {
        cached.busy = true;
        return { worker: cached, retained: true, continuation: true, sessionId };
      }
      processCache.delete(sessionId!);
      await cached.close();
    }

    // A concurrent request must not mutate the cached conversation. It gets a
    // one-shot process, as does a request without Pi's stable session ID.
    const retain = !!sessionId && !cached?.busy;
    if (retain) {
      while (processCache.size >= MAX_CACHED_CLAUDE_PROCESSES) {
        const victim = [...processCache.entries()]
          .filter(([, worker]) => !worker.busy)
          .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
        if (!victim) break;
        processCache.delete(victim[0]);
        await victim[1].close();
      }
    }

    const worker = await ClaudeProcess.create(input, plan);
    worker.busy = true;
    const retained = retain && processCache.size < MAX_CACHED_CLAUDE_PROCESSES;
    if (retained) processCache.set(sessionId!, worker);
    return { worker, retained, continuation: false, sessionId };
  });
}

/** Close warm Claude processes for one Pi session, or all sessions. */
export async function closeClaudeProcesses(sessionId?: string): Promise<void> {
  const workers = await withManagerLock(() => {
    if (sessionId) {
      const worker = processCache.get(sessionId);
      processCache.delete(sessionId);
      return worker ? [worker] : [];
    }
    const all = [...processCache.values()];
    processCache.clear();
    return all;
  });
  await Promise.allSettled(workers.map((worker) => worker.close()));
}

/** Test/debug visibility without exposing child processes themselves. */
export function cachedClaudeProcessCount(): number {
  return processCache.size;
}

registerSessionResourceCleanup((sessionId) => {
  void closeClaudeProcesses(sessionId);
});

export async function runClaudeRequest(input: RunClaudeInput): Promise<RunClaudeOutput> {
  const baseDelay = input.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  for (let attempt = 1; ; attempt++) {
    const delivery = new BufferedDelivery(input.onEvent, input.deliveryBufferMs ?? DELIVERY_BUFFER_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, delivery.signal]) : delivery.signal;
    try {
      const output = await runClaudeRequestOnce({ ...input, signal, onEvent: delivery.onEvent });
      delivery.throwIfFailed();
      delivery.flush();
      return output;
    } catch (caught) {
      delivery.discard();
      // A timer-driven flush whose onEvent threw aborted this attempt: that throw is the request's failure.
      const error = delivery.failure ?? caught;
      if (delivery.signal.aborted) throw error;
      // Never retry after events reached the caller (a replay would duplicate streamed output), after an abort, or
      // once a tool call started. runClaudeRequestOnce already discarded exactly its own failed worker.
      if (!(error instanceof IncompleteClaudeResponse) || input.signal?.aborted || delivery.flushed || delivery.sawToolUse) {
        throw error;
      }
      const maxAttempts = maxAttemptsFor(error);
      if (attempt >= maxAttempts) {
        if (attempt > 1) error.message += ` [gave up after ${attempt} attempts]`;
        throw error;
      }
      // Forget cached readiness and respawn cold with a full replay (owner-visible loops on 2026-10-26).
      readyStatusCache.clear();
      await sleep(baseDelay * 2 ** (attempt - 1), input.signal);
    }
  }
}

async function runClaudeRequestOnce(input: RunClaudeInput): Promise<RunClaudeOutput> {
  input.signal?.throwIfAborted();
  const plan = launchPlan(input);
  const acquired = await acquireProcess(input, plan);
  try {
    const output = await acquired.worker.run(input, acquired.continuation);
    const stable = acquired.worker.commit(input, output.message);
    if (
      stable &&
      acquired.retained &&
      acquired.sessionId &&
      processCache.get(acquired.sessionId) === acquired.worker
    ) {
      acquired.worker.busy = false;
      acquired.worker.armExpiryTimer(() => {
        void expireProcess(acquired.sessionId!, acquired.worker);
      });
    } else {
      await discardProcess(acquired);
    }
    return output;
  } catch (error) {
    await discardProcess(acquired);
    throw error;
  }
}
