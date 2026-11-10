import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cachedClaudeProcessCount, closeClaudeProcesses, runClaudeRequest } from "../src/claude-cli.ts";

// Fake `claude`: behaviour per spawn is chosen by a counter file. MODE=bad-first: first child answers with a result but no
// assistant/message_stop (the "Incomplete Claude Code response" shape); later children are fine. MODE=always-bad: never fine.
const script = `#!/usr/bin/env node
import readline from "node:readline";
import {appendFileSync, readFileSync, existsSync} from "node:fs";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "test"})); process.exit(0);
}
appendFileSync(process.env.SPAWN_LOG, process.pid + "\\n");
const spawns = readFileSync(process.env.SPAWN_LOG, "utf8").trim().split("\\n").length;
const bad = process.env.MODE === "always-bad" || (process.env.MODE === "bad-first" && spawns === 1);
if (process.env.MODE === "exit-first" && spawns === 1) process.exit(0);
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.shouldQuery === false) { console.log(JSON.stringify({type: "result", num_turns: 0})); continue; }
  if (frame.type !== "user") continue;
  const usage = {input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
  if (process.env.MODE === "partial") {
    console.log(JSON.stringify({type: "stream_event", event: {type: "message_start", message: {id: "m", role: "assistant", content: [], usage}}}));
    console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage})); continue;
  }
  if (process.env.MODE === "relay") {
    // Like the real CLI: call the relay base URL; the upstream behind it is dead.
    await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {method: "POST", body: JSON.stringify({messages: [frame.message]})}).catch(() => {});
    console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage})); continue;
  }
  if (bad) { console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage})); continue; }
  for (const event of [
    {type: "message_start", message: {id: "m", role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
    {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "ok"}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "end_turn"}, usage},
    {type: "message_stop"}]) console.log(JSON.stringify({type: "stream_event", event}));
  console.log(JSON.stringify({type: "assistant", message: {id: "m", role: "assistant", content: [{type: "text", text: "ok"}], stop_reason: "end_turn", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage}));
}
`;

async function setup(mode: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-incomplete-"));
  const exe = join(root, "fake-claude.mjs");
  await writeFile(exe, script); await chmod(exe, 0o755);
  const log = join(root, "spawns.log"); await writeFile(log, "");
  const input = () => ({
    model: "sonnet", cwd: root, systemPrompt: "s", manifest: [], extraBody: { tools: [] }, toolNames: new Set<string>(), timeoutMs: 5_000,
    sessionId: "loop-session", env: { PI_CLAUDE_CODE_COMMAND: exe, SPAWN_LOG: log, MODE: mode },
    frames: [{ type: "user" as const, message: { role: "user" as const, content: [{ type: "text", text: "hi" }] } }],
  });
  const spawns = async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).length;
  return { root, input, spawns };
}

test("an incomplete response tears down the child and the next attempt respawns a fresh one", async () => {
  const t = await setup("bad-first");
  try {
    const out = await runClaudeRequest(t.input());
    assert.equal(out.message.content[0]?.type, "text");
    assert.equal(await t.spawns(), 2, "dead child replaced by a fresh spawn in the same request");
    assert.equal(cachedClaudeProcessCount(), 1, "only the healthy worker stays cached");
    const again = await runClaudeRequest({ ...t.input(), frames: [...t.input().frames] });
    assert.ok(again.message);
  } finally { await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
});

test("a persistently broken child fails after exactly one respawn, carries clues, and leaves no cached worker", async () => {
  const t = await setup("always-bad");
  try {
    for (let turn = 0; turn < 3; turn++) {
      await assert.rejects(runClaudeRequest(t.input()), (error: Error) => {
        assert.match(error.message, /Incomplete Claude Code response/);
        assert.match(error.message, /events: .*result:success/, "event trace is in the message");
        assert.match(error.message, /relay unused/);
        return true;
      });
      assert.equal(cachedClaudeProcessCount(), 0);
    }
    assert.equal(await t.spawns(), 6, "2 spawns per request: one retry, no loop");
  } finally { await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
});

test("no retry once events were streamed to the caller (a replay would duplicate output)", async () => {
  const t = await setup("partial");
  try {
    const events: string[] = [];
    await assert.rejects(runClaudeRequest({ ...t.input(), onEvent: (e: { type: string }) => events.push(e.type) } as never), /Incomplete Claude Code response/);
    assert.deepEqual(events, ["message_start"]);
    assert.equal(await t.spawns(), 1);
    assert.equal(cachedClaudeProcessCount(), 0);
  } finally { await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
});

test("relay failure (unreachable upstream, AggregateError) is torn down and retried, not left cached", async () => {
  const t = await setup("relay");
  try {
    // Loopback with nothing listening: connect failure is surfaced by the relay.
    await assert.rejects(runClaudeRequest({ ...t.input(), upstreamUrl: "http://127.0.0.1:9" }), (e: Error) => {
      assert.match(e.message, /Claude Code upstream connection lost before a response \(status unknown, capture incomplete, relay failure (AggregateError|Error)/);
      return true;
    });
    assert.equal(await t.spawns(), 2, "respawned once");
    assert.equal(cachedClaudeProcessCount(), 0);
  } finally { await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
});
