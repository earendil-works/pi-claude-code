import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  closeClaudeProcesses,
  INHERIT_SETTINGS_AUTH_ENV,
  rewriteInitialRequest,
  runClaudeRequest,
} from "../src/claude-cli.ts";

const SAVED_AUTH = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;

function clearConflictingAuth(): () => void {
  const saved = SAVED_AUTH.map((key) => [key, process.env[key]] as const);
  for (const [key] of saved) delete process.env[key];
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const FAKE_CLAUDE = `#!/usr/bin/env node
import readline from "node:readline";

if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "test" }));
  process.exit(0);
}

const usage = { input_tokens: 3, output_tokens: 1 };
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.shouldQuery === false) {
    console.log(JSON.stringify({ type: "result", num_turns: 0 }));
    continue;
  }
  if (frame.type !== "user") continue;
  const text = frame.message.content.find((block) => block.type === "text")?.text ?? "";

  if (text === "not-logged-in") {
    console.log(JSON.stringify({
      type: "assistant",
      error: "authentication_failed",
      message: { id: "m_error", role: "assistant", stop_reason: "stop_sequence", usage, content: [{ type: "text", text: "Not logged in · Please run /login" }] },
    }));
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, num_turns: 1, usage }));
    continue;
  }

  if (text === "expect-token" && process.env.ANTHROPIC_AUTH_TOKEN !== process.env.EXPECTED_AUTH_TOKEN) {
    console.error("token was not inherited");
    process.exit(4);
  }
  if (text === "expect-no-token" && process.env.ANTHROPIC_AUTH_TOKEN !== undefined) {
    console.error("token leaked without opt-in");
    process.exit(5);
  }

  const events = [
    { type: "message_start", message: { id: "m_ok", role: "assistant", content: [], usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
    { type: "message_stop" },
  ];
  for (const event of events) console.log(JSON.stringify({ type: "stream_event", event }));
  console.log(JSON.stringify({ type: "assistant", message: { id: "m_ok", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage }));
}
`;

async function withFakeClaude(
  run: (context: { executable: string; configDir: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-cc-settings-auth-"));
  const executable = join(root, "fake-claude.mjs");
  const configDir = join(root, "claude-config");
  await writeFile(executable, FAKE_CLAUDE, "utf8");
  await chmod(executable, 0o755);
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "settings.json"),
    JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "settings-token" } }),
    "utf8",
  );
  const restore = clearConflictingAuth();
  try {
    await run({ executable, configDir });
  } finally {
    restore();
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true });
  }
}

function request(executable: string, configDir: string, text: string, extraEnv: Record<string, string> = {}) {
  return {
    model: "sonnet",
    systemPrompt: "system",
    manifest: [],
    frames: [{ type: "user" as const, message: { role: "user" as const, content: [{ type: "text", text }] } }],
    extraBody: { tools: [] },
    toolNames: new Set<string>(),
    timeoutMs: 10_000,
    env: {
      PI_CLAUDE_CODE_COMMAND: executable,
      CLAUDE_CONFIG_DIR: configDir,
      EXPECTED_AUTH_TOKEN: "settings-token",
      ...extraEnv,
    },
  };
}

test("passes a settings auth token through only when explicitly enabled", async () => {
  await withFakeClaude(async ({ executable, configDir }) => {
    const inherited = await runClaudeRequest(
      request(executable, configDir, "expect-token", { [INHERIT_SETTINGS_AUTH_ENV]: "1" }),
    );
    assert.equal(inherited.message.id, "m_ok");
  });
});

test("does not read settings auth without the opt-in", async () => {
  await withFakeClaude(async ({ executable, configDir }) => {
    const plain = await runClaudeRequest(request(executable, configDir, "expect-no-token"));
    assert.equal(plain.message.id, "m_ok");
  });
});

test("explains settings-based logins when Claude Code reports it is not logged in", async () => {
  await withFakeClaude(async ({ executable, configDir }) => {
    await assert.rejects(runClaudeRequest(request(executable, configDir, "not-logged-in")), (error: Error) => {
      assert.match(error.message, new RegExp(INHERIT_SETTINGS_AUTH_ENV));
      assert.match(error.message, /settings\.json/u);
      assert.match(error.message, /not logged in/iu);
      return true;
    });
  });
});

test("keeps cache_control TTLs in descending order on replay", () => {
  const canonical = [{ type: "text", text: "inspect" }];
  const current = {
    tools: [{ name: "a", cache_control: { type: "ephemeral", ttl: "1h" } }, { name: "b" }],
    messages: [
      { role: "user", content: [...canonical] },
      { role: "system", content: "environment reminder" },
      { role: "assistant", content: [{ type: "text", text: "first reply" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] },
    ],
  };
  const rematch = (initialSystemMessages: unknown[]) =>
    JSON.parse(
      rewriteInitialRequest(Buffer.from(JSON.stringify(current)), undefined, canonical, initialSystemMessages).toString(
        "utf8",
      ),
    ) as typeof current;

  const degraded = rematch([
    { role: "system", content: [{ type: "text", text: "environment", cache_control: { type: "ephemeral" } }] },
  ]);
  assert.deepEqual(
    (degraded.messages.at(-1)?.content as Array<Record<string, unknown>>).at(-1)?.cache_control,
    { type: "ephemeral" },
  );

  const preserved = rematch([{ role: "system", content: [{ type: "text", text: "environment" }] }]);
  assert.deepEqual(
    (preserved.messages.at(-1)?.content as Array<Record<string, unknown>>).at(-1)?.cache_control,
    { type: "ephemeral", ttl: "1h" },
  );
});
