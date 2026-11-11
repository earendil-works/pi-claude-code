import type { RateLimitInfo } from "./billing.ts";

export type JsonRecord = Record<string, unknown>;

export interface NativeUsage extends JsonRecord {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    [key: string]: unknown;
  };
  output_tokens_details?: {
    thinking_tokens?: number;
    [key: string]: unknown;
  };
}

export interface NativeMessage extends JsonRecord {
  id?: string;
  role: "assistant";
  content: NativeContentBlock[];
  usage?: NativeUsage;
  stop_reason?: string | null;
  stop_sequence?: string | null;
}

export type NativeContentBlock =
  | { type: "text"; text: string; [key: string]: unknown }
  | { type: "thinking"; thinking: string; signature?: string; [key: string]: unknown }
  | { type: "redacted_thinking"; data: string; [key: string]: unknown }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; [key: string]: unknown };

export interface NativeFrame {
  type: "user" | "assistant";
  message: {
    role: "user" | "assistant";
    content: unknown[];
    model?: string;
  };
  shouldQuery?: false;
}

export interface NativeResult extends JsonRecord {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
  usage?: NativeUsage;
  total_cost_usd?: number;
  modelUsage?: Record<string, unknown>;
}

export type NativeOutputEvent =
  | { type: "assistant"; message: NativeMessage; error?: unknown }
  | NativeResult
  | { type: "stream_event"; event: AnthropicStreamEvent }
  | { type: "rate_limit_event"; rate_limit_info?: RateLimitInfo }
  | { type: "control_response"; response: JsonRecord };

export type AnthropicStreamEvent =
  | { type: "message_start"; message: NativeMessage }
  | { type: "content_block_start"; index: number; content_block: NativeContentBlock }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "signature_delta"; signature: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason?: string | null; stop_sequence?: string | null; [key: string]: unknown };
      usage?: Partial<NativeUsage>;
    }
  | { type: "message_stop" }
  | { type: "error"; error?: { type?: string; message?: string } };
