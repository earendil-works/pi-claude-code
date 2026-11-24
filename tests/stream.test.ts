import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeClaudeProcesses } from "../src/claude-cli.ts";
import { CLAUDE_CODE_MODELS } from "../src/model-catalog.ts";
import { streamClaudeCode } from "../src/stream.ts";

test("hands Pi a tool call for a tool it never declared", async () => {
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
  const content = [{type: "tool_use", id: "tool_fake", name: "mcp__pi__aggregate_rum_events", input: {query: "*"}}];
  const events = [
    {type: "message_start", message: {id: "m_fake", role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: {type: "tool_use", id: "tool_fake", name: "mcp__pi__aggregate_rum_events", input: {}}},
    {type: "content_block_delta", index: 0, delta: {type: "input_json_delta", partial_json: '{"query":"*"}'}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "tool_use"}, usage},
    {type: "message_stop"}
  ];
  for (const event of events) console.log(JSON.stringify({type: "stream_event", event}));
  console.log(JSON.stringify({type: "assistant", message: {id: "m_fake", role: "assistant", content, stop_reason: "tool_use", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "error_max_turns", is_error: true, usage}));
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
    const message = await stream.result();
    assert.equal(message.stopReason, "toolUse", message.errorMessage);
    assert.deepEqual(
      message.content.map((block) => (block.type === "toolCall" ? [block.name, block.arguments] : block.type)),
      [["aggregate_rum_events", { query: "*" }]],
    );
  } finally {
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true });
  }
});

test("spawns Claude Code in the session cwd named by Pi's system prompt", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-code-cwd-")));
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
  const text = process.cwd();
  const usage = {input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
  const events = [
    {type: "message_start", message: {id: "m_cwd", role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
    {type: "content_block_delta", index: 0, delta: {type: "text_delta", text}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "end_turn"}, usage},
    {type: "message_stop"}
  ];
  for (const event of events) console.log(JSON.stringify({type: "stream_event", event}));
  console.log(JSON.stringify({type: "assistant", message: {id: "m_cwd", role: "assistant", content: [{type: "text", text}], stop_reason: "end_turn", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage}));
}
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  const first = join(root, "first");
  const second = join(root, "second");
  await Promise.all([mkdir(first), mkdir(second)]);

  const model = CLAUDE_CODE_MODELS.find((candidate) => candidate.id === "claude-opus-5-5")!;
  const ask = async (sections: Record<string, string> | undefined, sessionId: string) => {
    const message = await streamClaudeCode(
      model,
      {
        messages: [
          // A later section that quotes a <cwd> block must not redirect the worker.
          { role: "system", content: "", sections: { preamble: "system", ...sections, notes: "<cwd>\n/\n</cwd>" }, timestamp: 0 },
          { role: "user", content: [{ type: "text", text: "where am I" }], timestamp: 0 },
        ],
      } as never,
      { env: { PI_CLAUDE_CODE_COMMAND: executable }, timeoutMs: 5_000, sessionId } as never,
    ).result();
    assert.equal(message.stopReason, "stop", message.errorMessage);
    const text = message.content.find((block) => block.type === "text");
    return { cwd: text?.type === "text" ? text.text : undefined, diagnostics: message.diagnostics ?? [] };
  };
  const fallbackDiagnostic = (diagnostics: { type: string; details?: unknown }[]) =>
    diagnostics.find((diagnostic) => diagnostic.type === "claude-code.cwd-fallback")?.details;

  try {
    // Two sessions in one Pi process each get their own directory.
    assert.equal((await ask({ cwd: `<cwd>\n${first}\n</cwd>` }, "first")).cwd, first);
    assert.equal((await ask({ cwd: `<cwd>\n${second}\n</cwd>` }, "second")).cwd, second);

    // Without a cwd section, the worker keeps Pi's process cwd and nothing is reported.
    const unnamed = await ask(undefined, "unnamed");
    assert.equal(unnamed.cwd, await realpath(process.cwd()));
    assert.equal(fallbackDiagnostic(unnamed.diagnostics), undefined);

    // A named but unusable cwd falls back and leaves a diagnostic on the message.
    const missing = join(root, "missing");
    const gone = await ask({ cwd: `<cwd>\n${missing}\n</cwd>` }, "gone");
    assert.equal(gone.cwd, await realpath(process.cwd()));
    assert.deepEqual(fallbackDiagnostic(gone.diagnostics), {
      cwd: missing,
      reason: "not-a-directory",
      fallback: process.cwd(),
    });
  } finally {
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true });
  }
});
