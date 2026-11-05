import assert from "node:assert/strict";
import * as http from "node:http";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  cachedClaudeProcessCount,
  closeClaudeProcesses,
  discoverClaudeModels,
  getClaudeStatus,
  rewriteInitialRequest,
  runClaudeRequest,
} from "../src/claude-cli.ts";
import { createClaudeCodeProvider } from "../src/provider.ts";

test("stabilizes Claude Code's native replay reminders and cache breakpoint", () => {
  const canonical = [{ type: "text", text: "inspect" }];
  const prefix = [{ type: "text", text: "account reminder" }];
  const initialSystemMessages = [
    {
      role: "system",
      content: [
        {
          type: "text",
          text: "environment reminder\ndate reminder",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    },
  ];
  const current = {
    messages: [
      { role: "user", content: [{ type: "text", text: "changed reminder" }, ...canonical] },
      { role: "system", content: "environment reminder" },
      { role: "assistant", content: [{ type: "text", text: "first reply" }] },
      { role: "user", content: [...prefix, { type: "text", text: "follow up" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "old result" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "read", input: {} }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", content: "current result\naccount reminder" }],
      },
      {
        role: "system",
        content: [
          {
            type: "text",
            text: "date reminder",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      },
    ],
  };

  const rewritten = JSON.parse(
    rewriteInitialRequest(Buffer.from(JSON.stringify(current)), prefix, canonical, initialSystemMessages).toString("utf8"),
  ) as typeof current;
  assert.deepEqual(rewritten.messages[0]?.content, [...prefix, ...canonical]);
  assert.equal(
    ((rewritten.messages[1]?.content as Array<Record<string, unknown>>)[0]?.text as string),
    "environment reminder\ndate reminder",
  );
  assert.equal(
    ((rewritten.messages[1]?.content as Array<Record<string, unknown>>)[0]?.cache_control),
    undefined,
  );
  assert.equal(rewritten.messages.length, 8);
  assert.deepEqual(rewritten.messages[3]?.content, [{ type: "text", text: "follow up" }]);
  assert.equal(
    ((rewritten.messages[5]?.content as Array<Record<string, unknown>>)[0]?.content as string),
    "old result",
  );
  assert.deepEqual(
    (rewritten.messages[5]?.content as Array<Record<string, unknown>>).at(-1)?.cache_control,
    { type: "ephemeral", ttl: "1h" },
  );
  assert.equal(
    ((rewritten.messages[7]?.content as Array<Record<string, unknown>>)[0]?.content as string),
    "current result",
  );
  assert.deepEqual(
    (rewritten.messages.at(-1)?.content as Array<Record<string, unknown>>).at(-1)?.cache_control,
    { type: "ephemeral", ttl: "1h" },
  );
});

test("injects native system history at assistant boundaries", () => {
  const body = {
    system: [
      { type: "text", text: "identity", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "prompt", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "system", content: [{ type: "text", text: "environment" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
      { role: "system", content: [{ type: "text", text: "token reminder" }] },
    ],
  };
  const rewritten = JSON.parse(
    rewriteInitialRequest(Buffer.from(JSON.stringify(body)), undefined, body.messages[0]!.content, undefined, [
      {
        beforeAssistant: 0,
        content: [{ type: "tool_addition", tool: { type: "tool_reference", name: "mcp__pi__beta" } }],
      },
      {
        beforeAssistant: null,
        content: [{ type: "tool_removal", tool: { type: "tool_reference", name: "mcp__pi__alpha" } }],
      },
    ]).toString("utf8"),
  ) as typeof body;

  assert.deepEqual(rewritten.messages.map((message) => message.role), [
    "user",
    "system",
    "system",
    "assistant",
    "user",
    "system",
    "system",
  ]);
  assert.equal(
    ((rewritten.messages[2]?.content as Array<Record<string, unknown>>)[0] as Record<string, unknown>).type,
    "tool_addition",
  );
  assert.equal(
    ((rewritten.messages.at(-1)?.content as Array<Record<string, unknown>>)[0] as Record<string, unknown>).type,
    "tool_removal",
  );
  assert.equal((rewritten.system[0] as Record<string, unknown>).cache_control, undefined);
  assert.deepEqual((rewritten.system[1] as Record<string, unknown>).cache_control, {
    type: "ephemeral",
    ttl: "1h",
  });
  assert.deepEqual(
    (rewritten.messages.at(-1)?.content as Array<Record<string, unknown>>).at(-1)?.cache_control,
    { type: "ephemeral", ttl: "1h" },
  );
});

test("keeps one breakpoint in a pre-marked multi-block final message (issue #10)", () => {
  // Shape Claude Code sends for Fable after a tool result: a trailing system
  // message whose first block is already marked.
  const marker = { type: "ephemeral", ttl: "1h" };
  const body = {
    system: [
      { type: "text", text: "billing" },
      { type: "text", text: "identity", cache_control: marker },
      { type: "text", text: "prompt", cache_control: marker },
    ],
    tools: [{ name: "mcp__pi__bash", input_schema: { type: "object" }, cache_control: marker }],
    messages: [
      { role: "user", content: [{ type: "text", text: "run it" }] },
      { role: "system", content: "environment" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__pi__bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "hi" }] },
      {
        role: "system",
        content: [
          { type: "text", text: "date reminder", cache_control: marker },
          { type: "text", text: "parallel tool nudge" },
        ],
      },
    ],
  };
  const rewritten = JSON.parse(
    rewriteInitialRequest(
      Buffer.from(JSON.stringify(body)),
      undefined,
      body.messages[0]!.content as unknown[],
      [{ role: "system", content: [{ type: "text", text: "environment", cache_control: marker }] }],
      [],
    ).toString("utf8"),
  );
  const count = (value: unknown): number =>
    Array.isArray(value)
      ? value.reduce((sum: number, child) => sum + count(child), 0)
      : value && typeof value === "object"
        ? Object.entries(value).reduce(
            (sum: number, [key, child]) => sum + (key === "cache_control" ? 1 : count(child)),
            0,
          )
        : 0;
  assert.ok(count(rewritten) <= 4, `found ${count(rewritten)} cache_control markers`);
  const final = rewritten.messages.at(-1).content as Array<Record<string, unknown>>;
  assert.equal(final[0]?.cache_control, undefined);
  assert.deepEqual(final.at(-1)?.cache_control, marker);
});

const userFrame = (text: string) => ({
  type: "user" as const,
  message: { role: "user" as const, content: [{ type: "text", text }] },
});

for (const key of [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
]) {
  test(`rejects ${key} for model discovery and requests`, async () => {
    const env = { [key]: "1", ANTHROPIC_API_KEY: "pi-test-dummy" };
    const error = new RegExp(`refuses conflicting auth/backend overrides:.*${key}`);
    await assert.rejects(discoverClaudeModels(env), error);
    await assert.rejects(
      runClaudeRequest({
        model: "sonnet",
        frames: [],
        systemPrompt: "",
        manifest: [],
        extraBody: {},
        env,
      }),
      error,
    );
  });
}

test("runs a request through a stream-json Claude executable with an inherited API key", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-test-"));
  const workingRoot = await realpath(root);
  const script = join(root, "fake-claude.mjs");
  await writeFile(
    script,
    `#!/usr/bin/env node
import readline from "node:readline";
import {appendFileSync, readFileSync} from "node:fs";
if ("ANTHROPIC_API_KEY" in process.env) throw new Error("API key leaked to Claude child");
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "test"}));
  process.exit(0);
}
if (process.cwd() !== process.env.EXPECTED_CWD) throw new Error(\`wrong cwd: \${process.cwd()}\`);
if (process.env.CLAUDE_CODE_ENTRYPOINT !== "pi-agent") throw new Error(\`wrong entrypoint: \${process.env.CLAUDE_CODE_ENTRYPOINT}\`);
if (process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS !== "1") throw new Error("file mentions enabled");
if (process.env.PROCESS_LOG) appendFileSync(process.env.PROCESS_LOG, \`\${process.pid}\\n\`);
const systemIndex = process.argv.indexOf("--system-prompt-file");
if (systemIndex >= 0 && readFileSync(process.argv[systemIndex + 1], "utf8") !== process.env.EXPECTED_SYSTEM_PROMPT) {
  throw new Error("wrong system prompt");
}
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
let queryCount = 0;
// Real Claude Code echoes a frame's uuid on that frame's result.
const echoUuid = frame => frame.uuid ? {user_message_uuids: [frame.uuid]} : {};
const strayResult = {type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0};
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request" && frame.request?.subtype === "initialize") {
    console.log(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: frame.request_id,
        response: {
          models: [
            {value: "default", resolvedModel: "claude-opus-5-5[1m]", displayName: "Default", description: "Opus with 1M context"},
            {value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Efficient", supportsAdaptiveThinking: true}
          ]
        }
      }
    }));
    continue;
  }
  if (frame.shouldQuery === false) {
    console.log(JSON.stringify({type: "result", num_turns: 0, ...echoUuid(frame)}));
    continue;
  }
  if (frame.type !== "user") continue;
  queryCount += 1;
  const requestedTool = frame.message?.content?.some?.(block => block.type === "text" && block.text === "call-tool");
  const text = queryCount === 1 ? "ok" : \`ok\${queryCount}\`;
  const id = queryCount === 1 ? "m_fake" : \`m_fake_\${queryCount}\`;
  const usage = {input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
  if (requestedTool) {
    const content = [{type: "tool_use", id: "tool_fake", name: "mcp__pi__echo", input: {value: "test"}}];
    console.log(JSON.stringify({type: "stream_event", event: {type: "message_stop"}}));
    console.log(JSON.stringify({type: "assistant", message: {id, role: "assistant", content, stop_reason: "tool_use", usage}}));
    console.log(JSON.stringify({type: "result", subtype: "error_max_turns", is_error: true, usage, ...echoUuid(frame)}));
    continue;
  }
  if (process.env.NATIVE_ERROR) {
    const content = [{type: "text", text: "Usage limit"}];
    console.log(JSON.stringify({type: "assistant", error: "rate_limit", message: {id, role: "assistant", content, usage}}));
    console.log(JSON.stringify({type: "result", subtype: "success", is_error: true, usage, ...echoUuid(frame)}));
    continue;
  }
  const events = [
    {type: "message_start", message: {id, role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
    {type: "content_block_delta", index: 0, delta: {type: "text_delta", text}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "end_turn"}, usage},
    {type: "message_stop"}
  ];
  for (const event of events) console.log(JSON.stringify({type: "stream_event", event}));
  console.log(JSON.stringify({type: "assistant", message: {id, role: "assistant", content: [{type: "text", text}], stop_reason: "end_turn", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage, ...echoUuid(frame)}));
  // A result no turn waits for stays buffered until the next turn reads it.
  if (process.env.STALE_RESULT === "foreign") console.log(JSON.stringify({...strayResult, user_message_uuids: ["other"]}));
  if (process.env.STALE_RESULT === "bare") console.log(JSON.stringify(strayResult));
}
`,
    "utf8",
  );
  // Windows cannot execute a shebang script directly; go through a .cmd shim,
  // which also exercises the extension's cmd.exe launch path.
  const executable = process.platform === "win32" ? join(root, "fake-claude.cmd") : script;
  if (executable !== script) {
    await writeFile(executable, `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
  }
  await chmod(executable, 0o755);

  const events: string[] = [];
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = "pi-test-dummy";
    const provider = createClaudeCodeProvider();
    const authCheck = await provider.auth.apiKey?.check?.({
      ctx: {
        env: async (name) => (name === "PI_CLAUDE_CODE_COMMAND" ? executable : undefined),
        fileExists: async () => false,
      },
      signal: new AbortController().signal,
    });
    assert.equal(authCheck?.type, "oauth");
    assert.equal(provider.auth.oauth?.isSubscription, true);
    await assert.rejects(
      provider.auth.oauth!.login({
        signal: new AbortController().signal,
        prompt: async () => "",
        notify: () => {},
      }),
      /claude auth login/,
    );

    const explicitEnv = Object.freeze({
      PATH: process.env.PATH,
      PI_CLAUDE_CODE_COMMAND: executable,
      EXPECTED_CWD: process.cwd(),
      ANTHROPIC_API_KEY: "pi-test-explicit-dummy",
    });
    assert.equal((await getClaudeStatus(explicitEnv)).subscription, true);
    for (const env of [
      { PI_CLAUDE_CODE_COMMAND: executable, EXPECTED_CWD: process.cwd() },
      explicitEnv,
    ]) {
      const discovered = await discoverClaudeModels(env, undefined, 5_000);
      assert.deepEqual(discovered.map((model) => model.value), ["default", "sonnet"]);
    }

    const result = await runClaudeRequest({
      model: "sonnet",
      cwd: workingRoot,
      frames: [
        { type: "user", message: { role: "user", content: [{ type: "text", text: "old" }] }, shouldQuery: false },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "old reply" }] } },
        { type: "user", message: { role: "user", content: [{ type: "text", text: "new" }] } },
      ],
      systemPrompt: "system",
      manifest: [],
      extraBody: { tools: [] },
      env: {
        PI_CLAUDE_CODE_COMMAND: executable,
        EXPECTED_CWD: workingRoot,
        EXPECTED_SYSTEM_PROMPT: "system",
      },
      timeoutMs: 5_000,
      onEvent: (event) => events.push(event.type),
    });
    assert.equal(result.message.id, "m_fake");
    assert.equal(result.message.stop_reason, "end_turn");
    assert.equal(result.usage.input_tokens, 3);
    assert.equal(result.relay.upstreamRequests, 0);
    assert.equal(events.at(-1), "message_stop");

    const processLog = join(root, "processes.log");
    const common = {
      model: "sonnet",
      cwd: workingRoot,
      systemPrompt: "system",
      manifest: [],
      extraBody: { tools: [] },
      env: {
        PI_CLAUDE_CODE_COMMAND: executable,
        EXPECTED_CWD: workingRoot,
        EXPECTED_SYSTEM_PROMPT: "system",
        PROCESS_LOG: processLog,
        ANTHROPIC_API_KEY: explicitEnv.ANTHROPIC_API_KEY,
      },
      timeoutMs: 5_000,
    };
    const first = await runClaudeRequest({
      ...common,
      sessionId: "stable-session",
      frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "one" }] } }],
    });
    const second = await runClaudeRequest({
      ...common,
      sessionId: "stable-session",
      frames: [
        {
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "one" }] },
          shouldQuery: false,
        },
        { type: "assistant", message: { role: "assistant", content: first.message.content } },
        { type: "user", message: { role: "user", content: [{ type: "text", text: "two" }] } },
      ],
    });
    assert.equal(second.message.id, "m_fake_2");
    assert.equal((await readFile(processLog, "utf8")).trim().split("\n").length, 1);
    assert.equal(cachedClaudeProcessCount(), 1);

    // A branch mismatch replaces the warm process instead of risking stale
    // hidden Claude state.
    const branched = await runClaudeRequest({
      ...common,
      sessionId: "stable-session",
      frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "branch" }] } }],
    });
    assert.equal(branched.message.id, "m_fake");
    assert.equal((await readFile(processLog, "utf8")).trim().split("\n").length, 2);

    // Retained workers are deliberately bounded. Creating two more sessions
    // evicts the least-recently-used idle worker and leaves only two alive.
    for (const sessionId of ["second-session", "third-session"]) {
      await runClaudeRequest({
        ...common,
        sessionId,
        frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: sessionId }] } }],
      });
    }
    assert.equal(cachedClaudeProcessCount(), 2);
    assert.equal((await readFile(processLog, "utf8")).trim().split("\n").length, 4);

    // A tool call makes Claude's hidden history diverge because its inert MCP
    // server has already returned a denial. Never retain that process; replay
    // the real Pi tool result in a fresh process on the next request.
    const toolCommon = {
      ...common,
      manifest: [
        {
          name: "echo",
          description: "Echo a value",
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
        },
      ],
      extraBody: {
        tools: [
          {
            name: "mcp__pi__echo",
            description: "Echo a value",
            input_schema: { type: "object", properties: { value: { type: "string" } } },
          },
        ],
      },
    };
    const toolCall = await runClaudeRequest({
      ...toolCommon,
      sessionId: "tool-session",
      frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "call-tool" }] } }],
    });
    assert.equal(toolCall.message.stop_reason, "tool_use");
    assert.equal(cachedClaudeProcessCount(), 1);
    const afterTool = await runClaudeRequest({
      ...toolCommon,
      sessionId: "tool-session",
      frames: [
        {
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "call-tool" }] },
          shouldQuery: false,
        },
        { type: "assistant", message: { role: "assistant", content: toolCall.message.content } },
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool_fake", content: "echoed" }],
          },
        },
      ],
    });
    assert.equal(afterTool.message.id, "m_fake");
    assert.equal((await readFile(processLog, "utf8")).trim().split("\n").length, 6);
    assert.equal(explicitEnv.ANTHROPIC_API_KEY === "pi-test-explicit-dummy", true);
    assert.equal(common.env.ANTHROPIC_API_KEY === "pi-test-explicit-dummy", true);
    assert.equal(process.env.ANTHROPIC_API_KEY === "pi-test-dummy", true);

    // A late result for another user message must not end the next warm turn.
    const warmTurns = async (sessionId: string, extra: Record<string, string>) => {
      const warm = { ...common, env: { ...common.env, ...extra }, sessionId };
      const one = await runClaudeRequest({ ...warm, frames: [userFrame("one")] });
      return runClaudeRequest({
        ...warm,
        frames: [
          { ...userFrame("one"), shouldQuery: false },
          { type: "assistant", message: { role: "assistant", content: one.message.content } },
          userFrame("two"),
        ],
      });
    };
    const foreign = await warmTurns("foreign-session", { STALE_RESULT: "foreign" });
    assert.equal(foreign.message.id, "m_fake_2");
    assert.equal((await readFile(processLog, "utf8")).trim().split("\n").length, 7);

    // A stray result without a uuid fails the warm turn before any output, so
    // it is replayed once on a fresh process.
    const bare = await warmTurns("bare-session", { STALE_RESULT: "bare" });
    assert.equal(bare.message.id, "m_fake");
    assert.equal((await readFile(processLog, "utf8")).trim().split("\n").length, 9);

    // A native error assistant reports its text, not an incomplete response.
    await assert.rejects(
      runClaudeRequest({ ...common, env: { ...common.env, NATIVE_ERROR: "1" }, frames: [userFrame("one")] }),
      /Claude Code API error: Usage limit/,
    );
  } finally {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a dropped upstream stream as a retryable error", async () => {
  // Anthropic answers 200, starts streaming, then the connection drops.
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const usage = { input_tokens: 2, output_tokens: 0 };
    response.write(
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } })}\n\n`,
    );
    setTimeout(() => response.socket?.destroy(), 20);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing address");

  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-code-drop-")));
  const executable = join(root, "fake-claude.mjs");
  // Like Claude Code: read the stream, then retry once natively before giving up.
  await writeFile(
    executable,
    `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "max"}));
  process.exit(0);
}
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(\`\${process.env.ANTHROPIC_BASE_URL}/v1/messages\`, {method: "POST", body: "{}"});
      await response.text();
    } catch {}
  }
  console.log(JSON.stringify({type: "result", subtype: "error_during_execution", is_error: true}));
}
`,
    "utf8",
  );
  await chmod(executable, 0o755);

  try {
    const error = await runClaudeRequest({
      model: "sonnet",
      cwd: root,
      frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }],
      systemPrompt: "system",
      manifest: [],
      extraBody: { tools: [] },
      env: { PI_CLAUDE_CODE_COMMAND: executable },
      upstreamUrl: `http://127.0.0.1:${address.port}`,
      timeoutMs: 5_000,
    }).then(
      () => assert.fail("expected the dropped stream to fail"),
      (error: Error) => error,
    );
    assert.match(error.message, /status 200, capture incomplete/);
    assert.match(error.message, /native retries denied 1/);
    const failed = { role: "assistant", stopReason: "error", errorMessage: error.message } as AssistantMessage;
    assert.equal(isRetryableAssistantError(failed), true);
  } finally {
    closeClaudeProcesses();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
