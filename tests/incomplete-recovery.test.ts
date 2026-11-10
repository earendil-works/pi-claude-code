import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { cachedClaudeProcessCount, closeClaudeProcesses, runClaudeRequest } from "../src/claude-cli.ts";

// Fake `claude`: behaviour per spawn is chosen by a counter file. MODE=bad-first: first child answers with a result but no
// assistant/message_stop (the "Incomplete Claude Code response" shape); later children are fine. MODE=always-bad: never fine.
const script = `#!${process.execPath}
import readline from "node:readline";
import {appendFileSync, readFileSync, existsSync} from "node:fs";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "test"})); process.exit(0);
}
appendFileSync(process.env.SPAWN_LOG, process.pid + "\\n");
const spawns = readFileSync(process.env.SPAWN_LOG, "utf8").trim().split("\\n").length;
const bad = process.env.MODE === "always-bad" || (process.env.MODE === "bad-first" && spawns === 1);
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.shouldQuery === false) { console.log(JSON.stringify({type: "result", num_turns: 0})); continue; }
  if (frame.type !== "user") continue;
  const usage = {input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
  if (process.env.MODE === "cut-first" && spawns === 1) {
    for (const event of [
      {type: "message_start", message: {id: "m", role: "assistant", content: [], usage}},
      {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
      {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "partial"}}]) console.log(JSON.stringify({type: "stream_event", event}));
    console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage})); continue;
  }
  if (process.env.MODE === "cut-after-block") {
    for (const event of [
      {type: "message_start", message: {id: "m", role: "assistant", content: [], usage}},
      {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
      {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "done"}},
      {type: "content_block_stop", index: 0}]) console.log(JSON.stringify({type: "stream_event", event}));
    console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage})); continue;
  }
  if (process.env.MODE === "tool-cut") {
    for (const event of [
      {type: "message_start", message: {id: "m", role: "assistant", content: [], usage}},
      {type: "content_block_start", index: 0, content_block: {type: "tool_use", id: "t", name: "mcp__pi__x", input: {}}}]) console.log(JSON.stringify({type: "stream_event", event}));
    console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage})); continue;
  }
  if (process.env.MODE === "partial") {
    console.log(JSON.stringify({type: "stream_event", event: {type: "message_start", message: {id: "m", role: "assistant", content: [], usage}}}));
    console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage})); continue;
  }
  if (process.env.MODE === "relay") {
    // Like the real CLI: call the relay base URL; the upstream behind it is dead.
    await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {method: "POST", body: JSON.stringify({messages: [frame.message]})}).catch(() => {});
    console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage})); continue;
  }
  if (process.env.MODE === "slow-start") {
    // First block opens, then the child stalls well past the delivery buffer before finishing.
    for (const event of [
      {type: "message_start", message: {id: "m", role: "assistant", content: [], usage}},
      {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}}]) console.log(JSON.stringify({type: "stream_event", event}));
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (process.env.MODE === "hold-good") await new Promise((resolve) => setTimeout(resolve, 1200));
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
    sessionId: "loop-session", retryBaseDelayMs: 5, env: { PI_CLAUDE_CODE_COMMAND: exe, SPAWN_LOG: log, MODE: mode },
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

test("a persistently broken child fails after three attempts, carries clues, and leaves no cached worker", async () => {
  const t = await setup("always-bad");
  try {
    for (let turn = 0; turn < 3; turn++) {
      await assert.rejects(runClaudeRequest(t.input()), (error: Error) => {
        assert.match(error.message, /Incomplete Claude Code response/);
        assert.match(error.message, /events: .*result:success/, "event trace is in the message");
        assert.match(error.message, /relay unused/);
        assert.match(error.message, /gave up after 3 attempts/);
        return true;
      });
      assert.equal(cachedClaudeProcessCount(), 0);
    }
    assert.equal(await t.spawns(), 9, "3 spawns per request: two retries, no loop");
  } finally { await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
});

test("a cut before the first complete block is buffered, never delivered, and retried", async () => {
  const t = await setup("partial");
  try {
    const events: string[] = [];
    await assert.rejects(runClaudeRequest({ ...t.input(), onEvent: (e: { type: string }) => events.push(e.type) } as never), /Incomplete Claude Code response/);
    assert.deepEqual(events, [], "buffered events of failed attempts are dropped");
    assert.equal(await t.spawns(), 3);
    assert.equal(cachedClaudeProcessCount(), 0);
  } finally { await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
});

test("cut mid-block before flush: retried, caller sees only the good attempt's events", async () => {
  const t = await setup("cut-first");
  try {
    const events: string[] = [];
    const out = await runClaudeRequest({ ...t.input(), onEvent: (e: { type: string }) => events.push(e.type) } as never);
    assert.equal((out.message.content[0] as { text: string }).text, "ok");
    assert.equal(await t.spawns(), 2);
    assert.deepEqual(events, ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  } finally { await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
});

test("cut after a complete block was flushed: not retried (a replay would duplicate output)", async () => {
  const t = await setup("cut-after-block");
  try {
    const events: string[] = [];
    await assert.rejects(runClaudeRequest({ ...t.input(), onEvent: (e: { type: string }) => events.push(e.type) } as never), /Incomplete Claude Code response/);
    assert.deepEqual(events, ["message_start", "content_block_start", "content_block_delta", "content_block_stop"]);
    assert.equal(await t.spawns(), 1);
    assert.equal(cachedClaudeProcessCount(), 0);
  } finally { await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
});

test("buffer time limit flushes a slow first block; a later cut is then not retried", async () => {
  const t = await setup("partial");
  try {
    const events: string[] = [];
    await assert.rejects(
      runClaudeRequest({ ...t.input(), deliveryBufferMs: 0, onEvent: (e: { type: string }) => events.push(e.type) } as never),
      /Incomplete Claude Code response/,
    );
    assert.deepEqual(events, ["message_start"]);
    assert.equal(await t.spawns(), 1);
  } finally { await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
});

test("no retry once a tool_use block started", async () => {
  const t = await setup("tool-cut");
  try {
    await assert.rejects(runClaudeRequest(t.input()), /Incomplete Claude Code response/);
    assert.equal(await t.spawns(), 1);
  } finally { await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
});

test("no retry after abort", async () => {
  const t = await setup("always-bad");
  try {
    const controller = new AbortController();
    const run = runClaudeRequest({ ...t.input(), retryBaseDelayMs: 2_000, signal: controller.signal });
    const until = Date.now() + 3000;
    while ((await t.spawns()) < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    await assert.rejects(run);
    assert.equal(await t.spawns(), 1);
  } finally { await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
});

test("onEvent throwing in a timer-driven flush fails that request, no uncaughtException, no retry", async () => {
  const t = await setup("slow-start");
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    const started = Date.now();
    await assert.rejects(
      runClaudeRequest({
        ...t.input(), deliveryBufferMs: 100,
        onEvent: () => { throw new Error("unexpected tool from translator"); },
      } as never),
      /unexpected tool from translator/,
    );
    assert.ok(Date.now() - started < 1_400, "rejected at the flush, not after the child finished");
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(uncaught, []);
    assert.equal(await t.spawns(), 1, "a caller-side failure is not retried");
    assert.equal(cachedClaudeProcessCount(), 0, "the aborted worker is discarded");
  } finally {
    process.off("uncaughtException", onUncaught);
    await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true });
  }
});

test("abort during backoff sleep rejects well before retryBaseDelayMs", async () => {
  const t = await setup("always-bad");
  try {
    const controller = new AbortController();
    const run = runClaudeRequest({ ...t.input(), retryBaseDelayMs: 5_000, signal: controller.signal });
    const until = Date.now() + 3000;
    while ((await t.spawns()) < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 300)); // first attempt has failed; now in the 5 s backoff
    const aborted = Date.now();
    controller.abort();
    await assert.rejects(run);
    assert.ok(Date.now() - aborted < 1_000, `rejected ${Date.now() - aborted} ms after abort`);
    assert.equal(await t.spawns(), 1);
  } finally { await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
});

async function fakeUpstream(status: number, body: object) {
  const server = createServer((request, response) => {
    hits += 1;
    request.resume();
    request.on("end", () => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)));
  });
  let hits = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, hits: () => hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("429 is retried exactly once", async () => {
  const t = await setup("relay");
  const upstream = await fakeUpstream(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } });
  try {
    await assert.rejects(runClaudeRequest({ ...t.input(), upstreamUrl: upstream.url }), (e: Error) => {
      assert.match(e.message, /status 429/);
      assert.match(e.message, /slow down/);
      assert.match(e.message, /gave up after 2 attempts/);
      return true;
    });
    assert.equal(await t.spawns(), 2);
    assert.equal(upstream.hits(), 2);
  } finally { await upstream.close(); await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
});

test("529 overloaded gets three attempts; a 400 none", async () => {
  const t = await setup("relay");
  const overloaded = await fakeUpstream(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  const invalid = await fakeUpstream(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } });
  try {
    await assert.rejects(runClaudeRequest({ ...t.input(), upstreamUrl: overloaded.url }), /status 529.*Overloaded/);
    assert.equal(overloaded.hits(), 3);
    await assert.rejects(runClaudeRequest({ ...t.input(), upstreamUrl: invalid.url }), /status 400/);
    assert.equal(invalid.hits(), 1);
  } finally { await overloaded.close(); await invalid.close(); await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
});

test("relay failure (unreachable upstream, AggregateError) is torn down and retried, not left cached", async () => {
  const t = await setup("relay");
  try {
    // Loopback with nothing listening: connect failure is surfaced by the relay.
    await assert.rejects(runClaudeRequest({ ...t.input(), upstreamUrl: "http://127.0.0.1:9" }), (e: Error) => {
      assert.match(e.message, /Claude Code upstream connection lost before a response \(status unknown, capture incomplete, relay failure (AggregateError|Error).*ECONNREFUSED/);
      return true;
    });
    assert.equal(await t.spawns(), 3, "stream cut: three attempts");
    assert.equal(cachedClaudeProcessCount(), 0);
  } finally { await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
});

for (const failingSession of [undefined, "healthy"] as const) {
  test(`a concurrent healthy request survives another request's incomplete-response recovery (failing sessionId ${failingSession ?? "undefined"})`, async () => {
    const t = await setup("hold-good");
    try {
      let outcome: { ok: boolean; message?: string } | undefined;
      const healthy = runClaudeRequest(t.input()).then(() => (outcome = { ok: true }), (e: Error) => (outcome = { ok: false, message: e.message }));
      const until = Date.now() + 2000;
      while (cachedClaudeProcessCount() !== 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      assert.equal(cachedClaudeProcessCount(), 1);
      const bad = t.input();
      bad.env = { ...bad.env, MODE: "always-bad" };
      await assert.rejects(runClaudeRequest({ ...bad, sessionId: failingSession } as never), /Incomplete Claude Code response/);
      await healthy;
      assert.deepEqual(outcome, { ok: true }, outcome?.message);
    } finally { await closeClaudeProcesses(); await rm(t.root, { recursive: true, force: true }); }
  });
}
