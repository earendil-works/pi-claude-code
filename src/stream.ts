import {
  calculateCost,
  collapseSystemMessages,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  getInitialSystemMessage,
  getSystemMessageText,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type ThinkingContent,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { describeUsageCreditsRejection } from "./billing.ts";
import { runClaudeRequest } from "./claude-cli.ts";
import { nativeModel, supportsNativeToolChanges } from "./model-catalog.ts";
import type { AnthropicStreamEvent, NativeContentBlock, NativeMessage, NativeUsage } from "./native-types.ts";
import {
  buildExtraBody,
  getInitialSystemMessages,
  makeReplayDiagnostic,
  NATIVE_TOOL_CHANGES_BETA,
  prepareFrames,
  prepareMessages,
  prepareNativeTranscript,
  prepareTools,
  TOOL_PREFIX,
} from "./transcript.ts";

interface IndexedText {
  type: "text";
  text: string;
  nativeIndex: number;
}

interface IndexedThinking extends ThinkingContent {
  nativeIndex: number;
}

interface IndexedToolCall extends ToolCall {
  nativeIndex: number;
  partialJson: string;
}

type IndexedBlock = IndexedText | IndexedThinking | IndexedToolCall;

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function mapStopReason(reason: string | null | undefined): {
  stopReason: StopReason;
  errorMessage?: string;
} {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return { stopReason: "stop" };
    case "max_tokens":
    case "model_context_window_exceeded":
      return { stopReason: "length" };
    case "tool_use":
      return { stopReason: "toolUse" };
    case "refusal":
      return { stopReason: "error", errorMessage: "The model refused to complete the request" };
    case "sensitive":
      return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
    default:
      return { stopReason: "error", errorMessage: `Unhandled Claude Code stop reason: ${reason ?? "missing"}` };
  }
}

function parseArguments(raw: string, fallback: ToolCall["arguments"]): ToolCall["arguments"] {
  if (!raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ToolCall["arguments"]) : fallback;
  } catch {
    return fallback;
  }
}

function updateUsage(output: AssistantMessage, model: Model<any>, usage: Partial<NativeUsage> | undefined): void {
  if (!usage) return;
  if (typeof usage.input_tokens === "number") output.usage.input = usage.input_tokens;
  if (typeof usage.output_tokens === "number") output.usage.output = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === "number") output.usage.cacheRead = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === "number") output.usage.cacheWrite = usage.cache_creation_input_tokens;
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens;
  if (typeof oneHour === "number") output.usage.cacheWrite1h = oneHour;
  const thinking = usage.output_tokens_details?.thinking_tokens;
  if (typeof thinking === "number") output.usage.reasoning = thinking;
  output.usage.totalTokens =
    output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  calculateCost(model, output.usage);
}

function comparableContent(content: AssistantMessage["content"]): unknown[] {
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "thinking") {
      return {
        type: "thinking",
        thinking: block.thinking,
        thinkingSignature: block.thinkingSignature,
        redacted: block.redacted,
      };
    }
    return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
  });
}

// Claude can name a tool that Pi never declared. Pi's agent loop answers that
// with a "not found" tool result the model can recover from, so the name passes
// through rather than failing the turn.
function piToolName(nativeName: string): string {
  return nativeName.startsWith(TOOL_PREFIX) ? nativeName.slice(TOOL_PREFIX.length) : nativeName;
}

function nativeContent(content: NativeContentBlock[]): AssistantMessage["content"] {
  const converted: AssistantMessage["content"] = [];
  for (const block of content) {
    if (block.type === "text") {
      converted.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      converted.push({
        type: "thinking",
        thinking: block.thinking,
        thinkingSignature: block.signature,
      });
    } else if (block.type === "redacted_thinking") {
      converted.push({
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: block.data,
        redacted: true,
      });
    } else if (block.type === "tool_use") {
      converted.push({ type: "toolCall", id: block.id, name: piToolName(block.name), arguments: block.input as never });
    }
  }
  return converted;
}

class EventTranslator {
  private readonly nativeToContent = new Map<number, number>();
  private sawContentEvent = false;

  constructor(
    private readonly model: Model<any>,
    private readonly output: AssistantMessage,
    private readonly stream: AssistantMessageEventStream,
  ) {}

  event(event: AnthropicStreamEvent): void {
    switch (event.type) {
      case "message_start":
        if (event.message.id) this.output.responseId = event.message.id;
        updateUsage(this.output, this.model, event.message.usage);
        break;
      case "content_block_start":
        this.startBlock(event.index, event.content_block);
        break;
      case "content_block_delta":
        this.delta(event.index, event.delta);
        break;
      case "content_block_stop":
        this.stopBlock(event.index);
        break;
      case "message_delta": {
        if (event.delta.stop_reason) {
          this.output.rawStopReason = event.delta.stop_reason;
          const mapped = mapStopReason(event.delta.stop_reason);
          this.output.stopReason = mapped.stopReason;
          this.output.errorMessage = mapped.errorMessage;
        }
        updateUsage(this.output, this.model, event.usage);
        break;
      }
    }
  }

  finish(
    message: NativeMessage,
    usage: NativeUsage,
    initialSystemMessages?: unknown[],
  ): void {
    const authoritative = nativeContent(message.content);
    if (!this.sawContentEvent) {
      this.emitComplete(authoritative);
    } else if (JSON.stringify(comparableContent(this.output.content)) !== JSON.stringify(comparableContent(authoritative))) {
      throw new Error("Claude Code final response differs from its incremental stream");
    }

    if (message.id) this.output.responseId = message.id;
    updateUsage(this.output, this.model, usage);
    this.output.rawStopReason = message.stop_reason ?? undefined;
    const mapped = mapStopReason(message.stop_reason);
    this.output.stopReason = mapped.stopReason;
    this.output.errorMessage = mapped.errorMessage;
    this.output.diagnostics = [
      ...(this.output.diagnostics ?? []),
      makeReplayDiagnostic(message, this.output, initialSystemMessages) as never,
    ];
  }

  private startBlock(nativeIndex: number, native: NativeContentBlock): void {
    this.sawContentEvent = true;
    const contentIndex = this.output.content.length;
    this.nativeToContent.set(nativeIndex, contentIndex);
    if (native.type === "text") {
      this.output.content.push({ type: "text", text: native.text ?? "", nativeIndex } as IndexedText);
      this.stream.push({ type: "text_start", contentIndex, partial: this.output });
    } else if (native.type === "thinking") {
      this.output.content.push({
        type: "thinking",
        thinking: native.thinking ?? "",
        thinkingSignature: native.signature ?? "",
        nativeIndex,
      } as IndexedThinking);
      this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
    } else if (native.type === "redacted_thinking") {
      this.output.content.push({
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: native.data,
        redacted: true,
        nativeIndex,
      } as IndexedThinking);
      this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
    } else if (native.type === "tool_use") {
      this.output.content.push({
        type: "toolCall",
        id: native.id,
        name: piToolName(native.name),
        arguments: (native.input ?? {}) as ToolCall["arguments"],
        nativeIndex,
        partialJson: "",
      } as IndexedToolCall);
      this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
    }
  }

  private delta(nativeIndex: number, delta: Extract<AnthropicStreamEvent, { type: "content_block_delta" }>["delta"]): void {
    const contentIndex = this.nativeToContent.get(nativeIndex);
    if (contentIndex === undefined) return;
    const block = this.output.content[contentIndex] as IndexedBlock | undefined;
    if (!block) return;

    if (delta.type === "text_delta" && block.type === "text") {
      block.text += delta.text;
      this.stream.push({ type: "text_delta", contentIndex, delta: delta.text, partial: this.output });
    } else if (delta.type === "thinking_delta" && block.type === "thinking") {
      block.thinking += delta.thinking;
      this.stream.push({ type: "thinking_delta", contentIndex, delta: delta.thinking, partial: this.output });
    } else if (delta.type === "signature_delta" && block.type === "thinking") {
      block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
    } else if (delta.type === "input_json_delta" && block.type === "toolCall") {
      block.partialJson += delta.partial_json;
      block.arguments = parseArguments(block.partialJson, block.arguments);
      this.stream.push({ type: "toolcall_delta", contentIndex, delta: delta.partial_json, partial: this.output });
    }
  }

  private stopBlock(nativeIndex: number): void {
    const contentIndex = this.nativeToContent.get(nativeIndex);
    if (contentIndex === undefined) return;
    const block = this.output.content[contentIndex] as IndexedBlock | undefined;
    if (!block) return;
    delete (block as Partial<IndexedBlock>).nativeIndex;
    if (block.type === "text") {
      this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
    } else if (block.type === "thinking") {
      this.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
    } else {
      block.arguments = parseArguments(block.partialJson, block.arguments);
      delete (block as Partial<IndexedToolCall>).partialJson;
      this.stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: this.output });
    }
  }

  private emitComplete(content: AssistantMessage["content"]): void {
    for (const source of content) {
      const contentIndex = this.output.content.length;
      if (source.type === "text") {
        this.output.content.push({ ...source });
        this.stream.push({ type: "text_start", contentIndex, partial: this.output });
        if (source.text) this.stream.push({ type: "text_delta", contentIndex, delta: source.text, partial: this.output });
        this.stream.push({ type: "text_end", contentIndex, content: source.text, partial: this.output });
      } else if (source.type === "thinking") {
        this.output.content.push({ ...source });
        this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
        if (source.thinking && !source.redacted) {
          this.stream.push({ type: "thinking_delta", contentIndex, delta: source.thinking, partial: this.output });
        }
        this.stream.push({ type: "thinking_end", contentIndex, content: source.thinking, partial: this.output });
      } else {
        this.output.content.push({ ...source });
        this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
        const json = JSON.stringify(source.arguments);
        if (json) this.stream.push({ type: "toolcall_delta", contentIndex, delta: json, partial: this.output });
        this.stream.push({ type: "toolcall_end", contentIndex, toolCall: source, partial: this.output });
      }
    }
  }
}

export function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const usageCredits = describeUsageCreditsRejection(message);
  if (usageCredits) return usageCredits;
  if (/prompt is too long|context(?:_| )length|context window exceeded|too many input tokens/iu.test(message)) {
    return `context_length_exceeded: ${message}`;
  }
  return message;
}

export function streamClaudeCode(
  model: Model<any>,
  sourceContext: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };

  void (async () => {
    try {
      const context = { ...sourceContext, messages: prepareMessages(sourceContext.messages, model) };
      const nativeTranscript = prepareNativeTranscript(
        context.messages,
        supportsNativeToolChanges(model.id),
      );
      const transcript = nativeTranscript ? context : collapseSystemMessages(context);
      const initialSystem = getInitialSystemMessage(transcript.messages);
      const systemPrompt = nativeTranscript
        ? initialSystem
          ? getSystemMessageText(initialSystem)
          : ""
        : getCurrentSystemPrompt(transcript.messages);
      const tools = getCurrentTools(transcript.messages);
      const frames = prepareFrames(transcript.messages);
      const initialSystemMessages = getInitialSystemMessages(transcript.messages);
      const preparedTools = prepareTools(tools);
      const extraBody = buildExtraBody(
        model.id,
        nativeTranscript?.requestTools ?? preparedTools.nativeTools,
        options,
      );
      const translator = new EventTranslator(model, output, stream);

      stream.push({ type: "start", partial: output });
      const response = await runClaudeRequest({
        model: nativeModel(model.id),
        cwd: process.cwd(),
        frames,
        systemPrompt,
        manifest: preparedTools.manifest,
        extraBody,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
        env: options?.env,
        initialSystemMessages,
        nativeSystemInjections: nativeTranscript?.systemInjections,
        betas: nativeTranscript ? [NATIVE_TOOL_CHANGES_BETA] : undefined,
        sessionId: options?.cacheRetention === "none" ? undefined : options?.sessionId,
        onEvent: (event) => translator.event(event),
      });
      translator.finish(response.message, response.usage, response.initialSystemMessages);
      output.providerThinkingLevel = options?.reasoning;
      output.diagnostics = [
        ...(output.diagnostics ?? []),
        {
          type: "claude-code.turn-relay",
          timestamp: Date.now(),
          details: response.relay as never,
        },
        ...(response.rateLimit
          ? [
              {
                type: "claude-code.rate-limit",
                timestamp: Date.now(),
                details: response.rateLimit as never,
              },
            ]
          : []),
      ];

      if (output.stopReason === "error" || output.stopReason === "aborted" || output.stopReason === "pending") {
        throw new Error(output.errorMessage || `Claude Code ended with ${output.stopReason}`);
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = normalizeError(error);
      for (const block of output.content) {
        delete (block as Partial<IndexedBlock>).nativeIndex;
        delete (block as Partial<IndexedToolCall>).partialJson;
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
