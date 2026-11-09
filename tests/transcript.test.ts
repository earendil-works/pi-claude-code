import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Message, Model, Tool } from "@earendil-works/pi-ai";
import {
  buildExtraBody,
  getInitialSystemMessages,
  makeReplayDiagnostic,
  normalizeInputSchema,
  prepareFrames,
  prepareMessages,
  prepareNativeTranscript,
  prepareTools,
  TOOL_PREFIX,
} from "../src/transcript.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("prepares replay frames and groups tool results", () => {
  const assistant: AssistantMessage = {
    role: "assistant",
    api: "test",
    provider: "claude-code",
    model: "sonnet",
    content: [
      { type: "thinking", thinking: "private", thinkingSignature: "signed" },
      { type: "text", text: "checking" },
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "t2", name: "read", arguments: { path: "b" } },
    ],
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  };
  const messages: Message[] = [
    { role: "system", content: "system", timestamp: 0 },
    { role: "user", content: "inspect", timestamp: 1 },
    assistant,
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "A" }],
      isError: false,
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "t2",
      toolName: "read",
      content: [{ type: "text", text: "B" }],
      isError: false,
      timestamp: 2,
    },
  ];

  const frames = prepareFrames(messages);
  assert.equal(frames.length, 3);
  assert.equal(frames[0]?.shouldQuery, false);
  assert.equal(frames[1]?.type, "assistant");
  assert.equal((frames[1]?.message.content[2] as { name: string }).name, `${TOOL_PREFIX}read`);
  assert.equal(frames[2]?.message.content.length, 2);
  assert.equal(frames[2]?.shouldQuery, undefined);
});

test("replays native signed blocks only while the visible projection is unchanged", () => {
  const assistant: AssistantMessage = {
    role: "assistant",
    api: "test",
    provider: "claude-code",
    model: "sonnet",
    content: [
      { type: "thinking", thinking: "private", thinkingSignature: "signed" },
      { type: "text", text: "visible" },
    ],
    usage,
    stopReason: "stop",
    timestamp: 1,
  };
  const native = {
    id: "m1",
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, thinking: "private", signature: "signed", extra: "preserved" },
      { type: "text" as const, text: "visible" },
    ],
    stop_reason: "end_turn",
  };
  const nativeSystems = [{ role: "system", content: [{ type: "text", text: "environment" }] }];
  assistant.diagnostics = [makeReplayDiagnostic(native, assistant, nativeSystems) as never];

  assert.deepEqual(getInitialSystemMessages([assistant]), nativeSystems);
  const original = prepareFrames([
    { role: "user", content: "go", timestamp: 0 },
    assistant,
    { role: "user", content: "again", timestamp: 2 },
  ]);
  assert.equal((original[1]?.message.content[0] as { extra?: string }).extra, "preserved");

  assistant.content[1] = { type: "text", text: "edited" };
  const edited = prepareFrames([
    { role: "user", content: "go", timestamp: 0 },
    assistant,
    { role: "user", content: "again", timestamp: 2 },
  ]);
  assert.deepEqual(edited[1]?.message.content, [{ type: "text", text: "edited" }]);
});

test("builds cache-stable native tool declarations and chronological system changes", () => {
  const alpha = {
    name: "alpha",
    description: "alpha",
    parameters: { type: "object", properties: {} },
  } as unknown as Tool;
  const beta = {
    name: "beta",
    description: "beta",
    parameters: { type: "object", properties: {} },
  } as unknown as Tool;
  const assistant: AssistantMessage = {
    role: "assistant",
    api: "test",
    provider: "claude-code",
    model: "opus",
    content: [{ type: "text", text: "one" }],
    usage,
    stopReason: "stop",
    timestamp: 3,
  };
  const messages: Message[] = [
    { role: "system", content: "base", toolsAdded: [alpha], timestamp: 0 },
    { role: "user", content: "first", timestamp: 1 },
    { role: "system", content: "beta is available", toolsAdded: [beta], timestamp: 2 },
    assistant,
    { role: "system", content: "alpha is gone", toolsRemoved: [{ name: "alpha" }], timestamp: 4 },
    { role: "user", content: "second", timestamp: 5 },
  ];

  const plan = prepareNativeTranscript(messages, true)!;
  assert.deepEqual(
    plan.requestTools.map((tool) => [tool.name, tool.defer_loading ?? false]),
    [
      [`${TOOL_PREFIX}alpha`, false],
      ["__pi_deferred_placeholder__", true],
      [`${TOOL_PREFIX}beta`, true],
    ],
  );
  assert.deepEqual(plan.requestTools[0]?.cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(plan.systemInjections[0]?.beforeAssistant, 0);
  assert.deepEqual(plan.systemInjections[0]?.content, [
    { type: "text", text: "beta is available" },
    { type: "tool_addition", tool: { type: "tool_reference", name: `${TOOL_PREFIX}beta` } },
  ]);
  assert.equal(plan.systemInjections[1]?.beforeAssistant, null);
  assert.deepEqual(plan.systemInjections[1]?.content, [
    { type: "text", text: "alpha is gone" },
    { type: "tool_removal", tool: { type: "tool_reference", name: `${TOOL_PREFIX}alpha` } },
  ]);

  assert.equal(prepareNativeTranscript(messages, false), undefined);
  assert.equal(
    prepareNativeTranscript(
      [
        { role: "system", content: "base", timestamp: 0 },
        { role: "system", content: "late", toolsAdded: [alpha], timestamp: 1 },
        { role: "user", content: "go", timestamp: 2 },
      ],
      true,
    ),
    undefined,
  );
  assert.equal(
    prepareNativeTranscript(
      [
        ...messages,
        { role: "system", content: "", toolsAdded: [{ ...alpha, description: "changed" }], timestamp: 6 },
      ],
      true,
    ),
    undefined,
  );
});

test("normalizes tool schemas and builds native generation fields", () => {
  const tools = [
    {
      name: "probe",
      description: "probe",
      parameters: {
        type: "object",
        properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } },
        required: ["value"],
      },
    },
  ] as unknown as Tool[];
  const prepared = prepareTools(tools);
  assert.equal(prepared.manifest[0]?.name, "probe");
  assert.equal(prepared.nativeTools[0]?.name, `${TOOL_PREFIX}probe`);
  assert.deepEqual(
    normalizeInputSchema({ oneOf: [{ type: "object" }, { type: "string" }] }),
    { type: "object", properties: {} },
  );
  assert.deepEqual(buildExtraBody("claude-sonnet-5", prepared.nativeTools, { reasoning: "minimal" }), {
    tools: prepared.nativeTools,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "low" },
  });
  assert.deepEqual(buildExtraBody("claude-haiku-4-5-20251001", [], {}), {
    tools: [],
    thinking: { type: "disabled" },
    context_management: { edits: [] },
  });
  assert.deepEqual(buildExtraBody("claude-sonnet-5", [], {}), {
    tools: [],
    thinking: { type: "disabled" },
    context_management: { edits: [] },
  });
  // Opus 5.5 rejects `thinking.type: disabled` (issue #2).
  for (const id of ["claude-opus-5-5", "default", "claude-fable-5-1"]) {
    assert.deepEqual(buildExtraBody(id, [], {}), {
      tools: [],
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });
  }
});

test("keeps native replay only for the same model without changing the source history", () => {
  const model = { id: "sonnet", api: "claude-code-stream-json", provider: "claude-code", input: ["text", "image"] } as unknown as Model<any>;
  const assistant: AssistantMessage = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [
      { type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque", redacted: true },
      { type: "text", text: "visible" },
    ],
    usage,
    stopReason: "stop",
    timestamp: 1,
  };
  const native = {
    role: "assistant" as const,
    content: [
      { type: "redacted_thinking" as const, data: "opaque" },
      { type: "text" as const, text: "visible" },
    ],
  };
  assistant.diagnostics = [makeReplayDiagnostic(native, assistant) as never];
  const messages: Message[] = [
    { role: "user", content: "go", timestamp: 0 },
    assistant,
    { role: "user", content: "again", timestamp: 2 },
  ];
  const original = structuredClone(messages);

  const sameModel = prepareFrames(prepareMessages(messages, model));
  assert.deepEqual(sameModel[1]?.message.content, native.content);
  const otherModel = prepareFrames(prepareMessages(messages, { ...model, id: "opus" }));
  assert.deepEqual(otherModel[1]?.message.content, [{ type: "text", text: "visible" }]);
  assert.deepEqual(messages, original);
});

test("normalizes foreign tool call ids and drops foreign reasoning before replay", () => {
  const id = "call_abc|fc_" + "x".repeat(400);
  const assistant: AssistantMessage = {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    content: [
      { type: "thinking", thinking: "", thinkingSignature: "encrypted" },
      { type: "thinking", thinking: "inspect the file", thinkingSignature: "foreign-thinking" },
      { type: "text", text: "checking", textSignature: "foreign-text" },
      { type: "toolCall", id, name: "read", arguments: { path: "a" }, thoughtSignature: "foreign-tool" },
    ],
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  };
  const model = { id: "sonnet", api: "claude-code", provider: "claude-code", input: ["text", "image"] } as unknown as Model<any>;
  const messages: Message[] = [
    { role: "user", content: "go", timestamp: 0 },
    assistant,
    { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "A" }], isError: false, timestamp: 2 },
  ];
  const original = structuredClone(messages);
  const prepared = prepareMessages(messages, model);
  const content = (prepared[1] as AssistantMessage).content;
  assert.deepEqual(content[0], { type: "text", text: "checking" });
  assert.equal("thoughtSignature" in content[1]!, false);
  const frames = prepareFrames(prepared);

  const toolUse = frames[1]?.message.content as Array<{ type: string; id: string }>;
  assert.deepEqual(toolUse.map((block) => block.type), ["text", "tool_use"]);
  assert.match(toolUse[1]!.id, /^[a-zA-Z0-9_-]{1,64}$/u);
  assert.equal((frames[2]?.message.content[0] as { tool_use_id: string }).tool_use_id, toolUse[1]!.id);
  assert.deepEqual(messages, original);
});

test("answers orphaned tool calls and skips aborted turns before replay", () => {
  const model = { id: "sonnet", api: "claude-code", provider: "claude-code", input: ["text"] } as unknown as Model<any>;
  const turn = (id: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
    role: "assistant",
    api: "claude-code",
    provider: "claude-code",
    model: "sonnet",
    content: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
    usage,
    stopReason,
    timestamp: 1,
  });
  const messages: Message[] = [
    { role: "user", content: "go", timestamp: 0 },
    turn("orphan", "toolUse"),
    { role: "user", content: "never mind", timestamp: 2 },
    turn("aborted", "aborted"),
    { role: "user", content: "continue", timestamp: 3 },
  ];
  const frames = prepareFrames(prepareMessages(messages, model));

  assert.deepEqual(frames.map((frame) => frame.type), ["user", "assistant", "user"]);
  const followUp = frames[2]!.message.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean }>;
  assert.equal(followUp[0]?.type, "tool_result");
  assert.equal(followUp[0]?.tool_use_id, "orphan");
  assert.equal(followUp[0]?.is_error, true);
  assert.equal(JSON.stringify(frames).includes("aborted"), false);
});

test("holds a system message between a tool call and its result without duplicating the result", () => {
  const model = { id: "sonnet", api: "claude-code", provider: "claude-code", input: ["text"] } as unknown as Model<any>;
  const assistant: AssistantMessage = {
    role: "assistant",
    api: "claude-code",
    provider: "claude-code",
    model: "sonnet",
    content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }],
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  };
  const messages: Message[] = [
    { role: "user", content: "go", timestamp: 0 },
    assistant,
    { role: "system", content: "update", timestamp: 2 },
    { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "A" }], isError: false, timestamp: 3 },
  ];
  const prepared = prepareMessages(messages, model);

  assert.deepEqual(prepared.map((message) => message.role), ["user", "assistant", "toolResult", "system"]);
  assert.equal(prepared.filter((message) => message.role === "toolResult").length, 1);
  assert.equal((prepared[2] as { isError: boolean }).isError, false);
});
