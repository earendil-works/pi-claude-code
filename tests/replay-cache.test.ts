import assert from "node:assert/strict";
import test from "node:test";
import { rewriteInitialRequest } from "../src/claude-cli.ts";

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

  // Claude Code marks its injected reminders with a default (5m) breakpoint;
  // Pi's replay marker must not claim a longer TTL after it.
  const degraded = rematch([
    { role: "system", content: [{ type: "text", text: "environment", cache_control: { type: "ephemeral" } }] },
  ]);
  assert.deepEqual(
    (degraded.messages.at(-1)?.content as Array<Record<string, unknown>>).at(-1)?.cache_control,
    { type: "ephemeral" },
  );

  // Without an earlier short-TTL marker the long TTL is preserved.
  const preserved = rematch([{ role: "system", content: [{ type: "text", text: "environment" }] }]);
  assert.deepEqual(
    (preserved.messages.at(-1)?.content as Array<Record<string, unknown>>).at(-1)?.cache_control,
    { type: "ephemeral", ttl: "1h" },
  );
});
