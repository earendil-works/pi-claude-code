import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_CODE_MODELS,
  modelFromDiscovery,
  nativeModel,
  supportsNativeToolChanges,
} from "../src/model-catalog.ts";

test("fallback catalog matches Claude Code's selectable model families", () => {
  assert.deepEqual(
    CLAUDE_CODE_MODELS.map((model) => model.id),
    [
      "default",
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ],
  );
  assert.equal(nativeModel("default"), "default");
  // Routed by the model the alias resolved to, keeping the 1M-context suffix.
  assert.equal(nativeModel("claude-opus-5-5"), "claude-opus-5-5[1m]");
  // An explicit model id is sent as that id. Claude Code repoints its family aliases ("sonnet",
  // "haiku") at newer models, so routing `claude-sonnet-5` through "sonnet" ran Sonnet 5.5.
  assert.equal(nativeModel("claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(nativeModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5-20251001");
  assert.equal(supportsNativeToolChanges("default"), true);
  assert.equal(supportsNativeToolChanges("claude-opus-5-5"), true);
  assert.equal(supportsNativeToolChanges("claude-fable-5-1"), true);
  assert.equal(supportsNativeToolChanges("claude-sonnet-5"), false);
});

test("never routes an explicit model id through a family alias that Claude Code may repoint", () => {
  for (const id of ["claude-sonnet-5", "claude-haiku-4-5-20251001"]) assert.equal(nativeModel(id), id, id);
  // A discovered row is routed by what its alias resolved to, never by the alias.
  modelFromDiscovery({
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet",
    description: "Sonnet 5.5",
    supportsAdaptiveThinking: true,
  });
  assert.equal(nativeModel("claude-sonnet-5-5"), "claude-sonnet-5-5");
  // Discovering a newer target for the same alias must not retarget the older row.
  assert.equal(nativeModel("claude-sonnet-5"), "claude-sonnet-5");
  modelFromDiscovery({ value: "opus[1m]", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Opus 5.5" });
  assert.equal(nativeModel("claude-opus-5-5"), "claude-opus-5-5[1m]");
  // A catalog row that Claude Code serves with 1M context keeps it.
  assert.equal(nativeModel("claude-fable-5-1"), "claude-fable-5-1[1m]");
  assert.equal(nativeModel("claude-sonnet-5[1m]"), "claude-sonnet-5[1m]");
});

test("keeps default as Claude Code's own choice even when it resolves to an exact model", () => {
  const model = modelFromDiscovery({
    value: "default",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Default",
    description: "Opus with 1M context",
    supportsAdaptiveThinking: true,
  });
  assert.equal(model.id, "default");
  assert.equal(nativeModel(model.id), "default");
});

test("keeps unresolved discovery routes and unknown explicit ids unchanged", () => {
  for (const resolvedModel of [undefined, ""]) {
    const value = resolvedModel === undefined ? "test-unresolved[1m]" : "test-empty-resolution";
    const model = modelFromDiscovery({ value, resolvedModel, displayName: "Test", description: "Test" });
    assert.equal(nativeModel(model.id), value);
  }
  assert.equal(nativeModel("claude-test-undiscovered"), "claude-test-undiscovered");
  assert.equal(nativeModel("claude-test-undiscovered[1m]"), "claude-test-undiscovered[1m]");
});

test("keeps unresolved family aliases rather than guessing their current targets", () => {
  for (const [value, id] of [["sonnet", "claude-sonnet-5"], ["opus[1m]", "claude-opus-5-5"]]) {
    const row = { value, displayName: "Test", description: "Test", supportsAdaptiveThinking: true };
    try {
      for (const resolvedModel of [undefined, ""]) {
        const model = modelFromDiscovery({ ...row, resolvedModel });
        assert.equal(model.id, id);
        assert.equal(nativeModel(id), value);
      }
    } finally {
      // Restore fallback routes so later tests do not inherit unresolved aliases.
      modelFromDiscovery({ ...row, resolvedModel: id });
    }
    assert.equal(nativeModel(id), `${id}${value.endsWith("[1m]") ? "[1m]" : ""}`);
  }
});

test("keeps a single context suffix from either discovery field", () => {
  for (const [label, valueSuffix, resolvedSuffix] of [
    ["value", "[1m]", ""],
    ["resolved", "", "[1m]"],
    ["both", "[1m]", "[1m]"],
    ["neither", "", ""],
  ]) {
    const id = `claude-test-context-${label}`;
    const model = modelFromDiscovery({
      value: `test-context-${label}${valueSuffix}`,
      resolvedModel: `${id}${resolvedSuffix}`,
      displayName: "Test",
      description: "Test",
    });
    assert.equal(model.id, id);
    assert.equal(nativeModel(id), `${id}${valueSuffix || resolvedSuffix}`);
  }
});

test("updates an existing row's context route without leaving a stale mapping", () => {
  const id = "claude-test-refresh";
  for (const suffix of ["[1m]", "", "[1m]"]) {
    modelFromDiscovery({
      value: `test-refresh${suffix}`,
      resolvedModel: id,
      displayName: "Test",
      description: "Test",
    });
    assert.equal(nativeModel(id), `${id}${suffix}`);
  }
});

test("maps discovered aliases to stable canonical Pi model ids", () => {
  const opus = modelFromDiscovery({
    value: "opus[1m]",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Opus (1M context)",
    description: "Opus 5.5 with 1M context",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high", "max"],
    supportsAdaptiveThinking: true,
  });
  assert.equal(opus.id, "claude-opus-5-5");
  assert.equal(opus.name, "Claude Opus 5.5");
  assert.equal(opus.contextWindow, 1_000_000);
  assert.deepEqual(opus.cost, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.deepEqual(opus.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });

  const future = modelFromDiscovery({
    value: "future",
    resolvedModel: "claude-future-1",
    displayName: "Future",
    description: "A newly available model",
  });
  assert.equal(future.id, "claude-future-1");
  assert.equal(future.cost.input, 0);
});
