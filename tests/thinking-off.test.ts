import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { effectiveThinkingOptions } from "../src/stream.ts";
import { buildExtraBody } from "../src/transcript.ts";

function model(id: string, extra: Partial<Model<any>> = {}): Model<any> {
  return {
    id,
    name: id,
    api: "claude-code-stream-json",
    provider: "claude-code",
    baseUrl: "process://claude-code",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    ...extra,
  } as Model<any>;
}

// Claude 5.x models: Anthropic rejects thinking.type "disabled", and Pi marks "off" unsupported.
const opus55 = model("claude-opus-5-5", {
  thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
});
const fable51 = model("claude-fable-5-1", { thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } });
const haiku45 = model("claude-haiku-4-5-20251001");

test("thinking off becomes the lowest supported level when a model cannot disable thinking", () => {
  assert.equal(effectiveThinkingOptions(opus55, undefined)?.reasoning, "low");
  assert.equal(effectiveThinkingOptions(opus55, { maxTokens: 2_000 })?.reasoning, "low");
  assert.equal(effectiveThinkingOptions(opus55, { maxTokens: 2_000 })?.maxTokens, 2_000);
  assert.equal(effectiveThinkingOptions(fable51, {})?.reasoning, "minimal");

  const body = buildExtraBody(opus55.id, [], effectiveThinkingOptions(opus55, {}));
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.equal(body.context_management, undefined);
  // "minimal" is sent as the lowest native effort.
  assert.deepEqual(buildExtraBody(fable51.id, [], effectiveThinkingOptions(fable51, {})).output_config, { effort: "low" });
});

test("models that can disable thinking keep it disabled", () => {
  const options = { maxTokens: 10 };
  assert.equal(effectiveThinkingOptions(haiku45, options), options);
  assert.equal(effectiveThinkingOptions(model("no-reasoning", { reasoning: false, thinkingLevelMap: { off: null } }), options), options);
  assert.deepEqual(buildExtraBody(haiku45.id, [], effectiveThinkingOptions(haiku45, {})).thinking, { type: "disabled" });
});

test("an explicit thinking level is never changed", () => {
  const options = { reasoning: "high" as const };
  assert.equal(effectiveThinkingOptions(opus55, options), options);
});
