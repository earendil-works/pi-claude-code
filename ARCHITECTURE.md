# Architecture

This document explains how pi-claude-code works internally. For installation
and usage, see [README.md](README.md).

## Overview

The extension registers a Pi provider that routes all Claude model
communication through the official Claude Code CLI. It talks to Claude Code
through Claude Code's native `stream-json` protocol and translates streamed
responses back into Pi's message format.

Pi remains responsible for conversation history, approvals, compaction, and tool
execution. The extension exposes Pi's tools to Claude Code through an inert MCP
inventory. Claude can request a tool, but Claude Code cannot execute it; the
request is returned to Pi instead.

## Authentication

Claude Code owns and stores its credentials. The extension does not read its
credential files, refresh its tokens, or persist them. Authenticated request
headers do pass transiently through the local turn relay described below.

Each turn runs Claude Code with `--setting-sources ""`, so user and project
settings cannot inject hooks, skills, or plugins into Pi's agent loop. That also
hides logins stored in those settings files, such as a `claude setup-token`
value in `env.ANTHROPIC_AUTH_TOKEN`. Setting
`PI_CLAUDE_CODE_INHERIT_SETTINGS_AUTH=1` passes only `ANTHROPIC_AUTH_TOKEN` and
`ANTHROPIC_API_KEY` from Claude Code's `settings.json` and
`settings.local.json` to the spawned process; it is opt-in so a settings token
never replaces the auth the user expects Pi to use. `claude auth login`
credentials are read by Claude Code itself and need no flag.

When a turn still ends without a usable assistant message because Claude Code
reported that it is not logged in, the error names that flag and the settings
file that holds a token instead of only reporting an incomplete response.

The provider has an ambient API-key-style auth method without a login flow. Its
`check()` runs `claude auth status` and reports the provider as configured only
when Claude Code is installed and logged in, so Pi hides the models otherwise.
Requests resolve to a placeholder key. It reports Claude
subscription logins as OAuth-shaped auth so that Pi labels list-price accounting
as a subscription. The provider also declares an `oauth` method, marked
`isSubscription`, only so Pi's subscription-aware UI works. Its `login()` never
starts a flow; it tells the user to run `claude auth login`.

Inherited API-key, proxy, Bedrock, Vertex, and Foundry overrides are rejected
to avoid silently changing authentication or billing.

## Usage-credit guard

Claude Code emits a `rate_limit_event` for each turn. If it reports
`isUsingOverage`, the response was charged to usage credits rather than plan
limits, and the turn fails with a non-retryable `Claude Code billing` error
unless `PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS` is set. Upstream rejections that
ask for usage credits (for example third-party app classification) are
rewritten into the same kind of error. The latest rate-limit status is attached
to the assistant message as a `claude-code.rate-limit` diagnostic.

## Process reuse

Linear conversations may reuse a warm Claude Code process. Only exact linear
continuations reuse one. Branches, edits, configuration changes, errors, and
tool-use boundaries fall back to a fresh process, which replays Pi's full
conversation. At most two processes are retained, and no process is retained
for more than five minutes.

## Local turn relay

Each Claude Code worker receives an `ANTHROPIC_BASE_URL` that points to a
random, loopback-only HTTP route owned by this extension.

The relay exists because Pi, rather than Claude Code, owns the agent loop and
tool execution. In particular, it:

- forwards exactly one Anthropic Messages request for each Pi turn and rejects
  additional native recovery attempts. Claude Code can otherwise issue another
  generation after an inert MCP tool call, even with one turn and HTTP retries
  disabled;
- captures and streams the first upstream response before Claude Code processes
  it, preserving signed thinking, tool arguments, usage, and the native stop
  reason. This lets Pi retain a valid tool request even when Claude Code later
  reports an `error_max_turns` boundary or a synthetic recovery error;
- records Claude Code's initial native user and system reminders, then restores
  their stable layout during full-history replay. It removes redundant moving
  reminders and adjusts cache breakpoints so tool rounds do not continually
  invalidate the prompt-cache prefix;
- injects supported mid-conversation tool additions and removals at their
  original assistant boundaries and adds the corresponding Anthropic beta
  header; and
- ties cancellation to the active upstream socket as well as the Claude Code
  process.

## Tool schemas

Tool schemas are normalized for Claude Code. Nullable variants and schema
composition such as `oneOf`, `allOf`, and `anyOf` may be simplified or removed.

Exact mid-conversation tool additions and removals, including prompt-cache
preservation, work only on supported models. Other cases fall back to the
current tool state and may lose prompt-cache reuse.
