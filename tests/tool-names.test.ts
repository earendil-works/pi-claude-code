import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage, Message, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { closeClaudeProcesses, runClaudeRequest } from "../src/claude-cli.ts";
import { streamClaudeCode } from "../src/stream.ts";
import * as transcript from "../src/transcript.ts";

const { canonicalizeToolUseNames, prepareFrames, resolveToolName, TOOL_PREFIX } = transcript;

test("resolveToolName: prefixed, bare, re-cased and unknown names", () => {
  const names = new Set(["bash", "read", "Grep", "grep"]);
  assert.deepEqual(resolveToolName("mcp__pi__bash", names), { name: "bash", known: true });
  assert.deepEqual(resolveToolName("bash", names), { name: "bash", known: true }, "bare name");
  assert.deepEqual(resolveToolName("Bash", names), { name: "bash", known: true }, "unique case-insensitive");
  assert.deepEqual(resolveToolName("MCP__PI__Read", names), { name: "read", known: true }, "prefix and name re-cased");
  assert.deepEqual(resolveToolName("grep", names), { name: "grep", known: true }, "exact wins over fold");
  assert.deepEqual(resolveToolName("GREP", names), { name: "GREP", known: false }, "ambiguous fold is not guessed");
  assert.deepEqual(resolveToolName("MCP__PI__Foo", names), { name: "MCP__PI__Foo", known: false });
  assert.deepEqual(resolveToolName("powershell", names), { name: "powershell", known: false });
  assert.deepEqual(resolveToolName("mcp__pi__powershell", names), { name: "powershell", known: false });
});

test("canonicalizeToolUseNames rewrites known names to the declared native name, leaves unknown ones", () => {
  const message = {
    id: "m",
    role: "assistant",
    content: [
      { type: "text", text: "x" },
      { type: "tool_use", id: "a", name: "Bash", input: {} },
      { type: "tool_use", id: "b", name: "powershell", input: {} },
      { type: "tool_use", id: "c", name: "MCP__PI__Foo", input: {} },
    ],
  } as never;
  canonicalizeToolUseNames(message, new Set(["bash"]));
  const names = (message as { content: Array<{ name?: string }> }).content.map((block) => block.name);
  assert.deepEqual(names, [undefined, `${TOOL_PREFIX}bash`, "powershell", "MCP__PI__Foo"]);
});

// Fake `claude` answering every query with one tool_use whose name comes from TOOL_NAME, then error_max_turns
// (what the real CLI does after its inert MCP denial).
const script = `#!${process.execPath}
import readline from "node:readline";
import {appendFileSync} from "node:fs";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "test"})); process.exit(0);
}
appendFileSync(process.env.SPAWN_LOG, process.pid + "\\n");
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.shouldQuery === false) { console.log(JSON.stringify({type: "result", num_turns: 0})); continue; }
  if (frame.type !== "user") continue;
  const usage = {input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
  if (process.env.MODE === "relay") {
    const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {method: "POST", body: JSON.stringify({messages: [frame.message]})}).catch(() => undefined);
    await response?.text().catch(() => {});
    console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage})); continue;
  }
  const name = process.env.TOOL_NAME;
  const block = {type: "tool_use", id: "toolu_1", name, input: {}};
  for (const event of [
    {type: "message_start", message: {id: "m", role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: block},
    {type: "content_block_delta", index: 0, delta: {type: "input_json_delta", partial_json: "{\\"command\\":\\"ls\\"}"}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "tool_use"}, usage},
    {type: "message_stop"}]) console.log(JSON.stringify({type: "stream_event", event}));
  console.log(JSON.stringify({type: "assistant", message: {id: "m", role: "assistant", content: [{...block, input: {command: "ls"}}], stop_reason: "tool_use", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "error_max_turns", is_error: true, usage}));
}
`;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-toolnames-"));
  const exe = join(root, "fake-claude.mjs");
  await writeFile(exe, script);
  await chmod(exe, 0o755);
  const log = join(root, "spawns.log");
  await writeFile(log, "");
  const spawns = async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).length;
  return { root, exe, log, spawns };
}

const model = {
  id: "claude-sonnet-5",
  name: "Sonnet 5",
  api: "claude-code",
  provider: "claude-code",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_000,
} as unknown as Model<any>;

const bash = { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };

function context(): TranscriptContext {
  return {
    messages: [
      { role: "system", content: "sys", toolsAdded: [bash], timestamp: 0 },
      { role: "user", content: "list files", timestamp: 1 },
    ],
  } as unknown as TranscriptContext;
}

async function run(t: Awaited<ReturnType<typeof setup>>, toolName: string): Promise<AssistantMessage> {
  const stream = streamClaudeCode(model, context(), {
    env: { PI_CLAUDE_CODE_COMMAND: t.exe, SPAWN_LOG: t.log, TOOL_NAME: toolName },
    timeoutMs: 5_000,
  });
  return stream.result();
}

for (const emitted of ["bash", "Bash", "mcp__pi__Bash", "mcp__pi__bash"]) {
  test(`a tool_use named "${emitted}" becomes Pi's bash call and replays as mcp__pi__bash`, async () => {
    const t = await setup();
    try {
      const message = await run(t, emitted);
      assert.equal(message.stopReason, "toolUse", message.errorMessage);
      const call = message.content.find((block) => block.type === "toolCall");
      assert.equal(call?.name, "bash");
      assert.deepEqual(call?.arguments, { command: "ls" });
      assert.equal(await t.spawns(), 1);

      // History replay: the carrier holds the canonical native name the API was declared with.
      const history = [
        ...context().messages,
        message,
        { role: "toolResult", toolCallId: "toolu_1", toolName: "bash", content: [{ type: "text", text: "a" }], isError: false, timestamp: 2 },
      ] as Message[];
      const frames = prepareFrames(history);
      const replayed = frames[1]!.message.content as Array<{ type: string; name?: string }>;
      assert.deepEqual(replayed.map((block) => block.name), [`${TOOL_PREFIX}bash`]);
    } finally {
      await closeClaudeProcesses();
      await rm(t.root, { recursive: true, force: true });
    }
  });
}

test("an unknown bare tool (powershell) is a Pi tool call, not a failed turn, and is not retried", async () => {
  const t = await setup();
  try {
    const message = await run(t, "powershell");
    assert.equal(message.stopReason, "toolUse", message.errorMessage);
    const call = message.content.find((block) => block.type === "toolCall");
    // Pi's agent loop answers an unknown name with the error tool result "Tool powershell not found".
    assert.equal(call?.name, "powershell");
    assert.equal(await t.spawns(), 1);
    const frames = prepareFrames([
      ...context().messages,
      message,
      { role: "toolResult", toolCallId: "toolu_1", toolName: "powershell", content: [{ type: "text", text: "Tool powershell not found" }], isError: true, timestamp: 2 },
    ] as Message[]);
    const replayed = frames[1]!.message.content as Array<{ name?: string }>;
    assert.deepEqual(replayed.map((block) => block.name), ["powershell"], "replayed exactly as the model said it");
  } finally {
    await closeClaudeProcesses();
    await rm(t.root, { recursive: true, force: true });
  }
});

test("a consumer throw inside the relay surfaces as itself, not an incomplete response", async () => {
  const t = await setup();
  const usage = { input_tokens: 3, output_tokens: 1 };
  const sse = [
    { type: "message_start", message: { id: "m", role: "assistant", content: [], usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => response.writeHead(200, { "content-type": "text/event-stream" }).end(sse));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const consumerError = new Error("translator rejected the event");
  try {
    await assert.rejects(
      runClaudeRequest({
        model: "sonnet",
        cwd: t.root,
        systemPrompt: "s",
        manifest: [],
        extraBody: { tools: [] },
        timeoutMs: 5_000,
        upstreamUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        env: { PI_CLAUDE_CODE_COMMAND: t.exe, SPAWN_LOG: t.log, MODE: "relay" },
        frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }],
        onEvent: () => {
          throw consumerError;
        },
      }),
      (error: Error) => {
        assert.equal(error, consumerError);
        return true;
      },
    );
    assert.equal(await t.spawns(), 1, "not retried");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeClaudeProcesses();
    await rm(t.root, { recursive: true, force: true });
  }
});
