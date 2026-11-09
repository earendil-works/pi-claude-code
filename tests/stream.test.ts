import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeClaudeProcesses } from "../src/claude-cli.ts";
import { CLAUDE_CODE_MODELS } from "../src/model-catalog.ts";
import { streamClaudeCode } from "../src/stream.ts";

/** Stream one turn through a fake Claude Code that replays `events` and reports `content` as its final message. */
async function streamFakeTurn(events: unknown[], content: unknown[], stopReason: string, result: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-stream-"));
  const executable = join(root, "fake-claude.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "test"}));
  process.exit(0);
}
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request" && frame.request?.subtype === "initialize") {
    console.log(JSON.stringify({type: "control_response", response: {subtype: "success", request_id: frame.request_id, response: {models: []}}}));
    continue;
  }
  if (frame.type !== "user") continue;
  const usage = {input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
  const events = ${JSON.stringify(events)};
  events[0].message.usage = usage;
  events.at(-2).usage = usage;
  for (const event of events) console.log(JSON.stringify({type: "stream_event", event}));
  console.log(JSON.stringify({type: "assistant", message: {id: "m_fake", role: "assistant", content: ${JSON.stringify(content)}, stop_reason: ${JSON.stringify(stopReason)}, usage}}));
  console.log(JSON.stringify({type: "result", subtype: ${JSON.stringify(result)}, is_error: ${result !== "success"}, usage}));
}
`,
    "utf8",
  );
  await chmod(executable, 0o755);

  try {
    const model = CLAUDE_CODE_MODELS.find((candidate) => candidate.id === "claude-opus-5-5")!;
    const stream = streamClaudeCode(
      model,
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "count errors" }], timestamp: 0 }],
        tools: [{ name: "mcp__datadog__aggregate_rum_events", description: "Aggregate RUM", parameters: { type: "object" } }],
      } as never,
      { env: { PI_CLAUDE_CODE_COMMAND: executable }, timeoutMs: 5_000, cacheRetention: "none" } as never,
    );
    const seen: string[] = [];
    for await (const event of stream) seen.push(event.type);
    return { message: await stream.result(), seen };
  } finally {
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true });
  }
}

const block = (index: number, content_block: unknown) => [
  { type: "content_block_start", index, content_block },
  { type: "content_block_stop", index },
];

test("hands Pi a tool call for a tool it never declared", async () => {
  const tool = { type: "tool_use", id: "tool_fake", name: "mcp__pi__aggregate_rum_events" };
  const { message } = await streamFakeTurn(
    [
      { type: "message_start", message: { id: "m_fake", role: "assistant", content: [] } },
      { type: "content_block_start", index: 0, content_block: { ...tool, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"*"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ],
    [{ ...tool, input: { query: "*" } }],
    "tool_use",
    "error_max_turns",
  );
  assert.equal(message.stopReason, "toolUse", message.errorMessage);
  assert.deepEqual(
    message.content.map((block) => (block.type === "toolCall" ? [block.name, block.arguments] : block.type)),
    [["aggregate_rum_events", { query: "*" }]],
  );
});

test("streams text, thinking and redacted thinking the same way as the final message", async () => {
  const content = [
    { type: "text", text: "" },
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "redacted_thinking", data: "opaque" },
  ];
  const { message, seen } = await streamFakeTurn(
    [
      { type: "message_start", message: { id: "m_fake", role: "assistant", content: [] } },
      ...content.flatMap((item, index) => block(index, item)),
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ],
    content,
    "end_turn",
    "success",
  );
  assert.equal(message.stopReason, "stop", message.errorMessage);
  assert.deepEqual(seen.filter((type) => type.endsWith("_start")), ["text_start", "thinking_start", "thinking_start"]);
  assert.deepEqual(message.content, [
    { type: "text", text: "" },
    { type: "thinking", thinking: "", thinkingSignature: "sig" },
    { type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque", redacted: true },
  ]);
});
