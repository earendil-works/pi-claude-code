# pi-claude-code

This Pi extension lets you use your Claude Pro or Max subscription in Pi by
routing all Claude model requests through the official Claude Code CLI.

Pi still handles conversation history, approvals, compaction, and tool
execution. Claude Code only talks to the model. It never runs tools itself.

> [!WARNING]
> **The future of this extension is uncertain.** Right now it works by running
> Pi's requests through the official Claude Code CLI in non-interactive mode
> (`claude -p`), and that usage counts against your normal Claude subscription
> limits. In May 2026 Anthropic
> [announced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
> that `claude -p`, Agent SDK, and third-party usage would move to a separate,
> smaller "Agent SDK credit" billed at API rates. Anthropic has since put that
> change on hold and says it will give advance notice before any future change.
>
> Until then the extension keeps working as described here, but that could
> change at any time. If Anthropic changes how `claude -p` usage is billed, this
> extension may cost more, stop drawing from your subscription, or stop working
> altogether. See Zed's
> [write-up](https://zed.dev/blog/anthropic-subscription-changes) for more
> background.

## Requirements

- Pi
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), installed and
  on your `PATH`:

  ```sh
  npm install -g @anthropic-ai/claude-code
  ```

- A Claude subscription that you are logged into with Claude Code

## Installation

```sh
pi install https://github.com/earendil-works/pi-claude-code
```

Then pick a model from the **Claude Code Subscription (Experimental)** provider
in Pi.

## Login and logout

Claude Code handles authentication. Log in and out with the Claude Code CLI:

```sh
claude auth login
claude auth logout
```

The extension uses whatever login Claude Code currently has. You don't need
Pi's `/login` or `/logout` for this provider. The extension doesn't read, copy,
or store your Claude Code credentials.

Run `/claude-code-status` in Pi to check that Claude Code is installed and
logged in.

## Configuration

These environment variables are optional:

- `PI_CLAUDE_CODE_COMMAND`: path or name of the Claude Code executable
  (default: `claude`).
- `PI_CLAUDE_CODE_CONFIG_DIR`: Claude Code config directory to use. The
  extension passes it to Claude Code as `CLAUDE_CONFIG_DIR`.

### Model discovery and privacy

The extension asks Claude Code for the account's model catalog automatically.
The discovery probe allows Claude Code's normal feature-flag and catalog traffic,
including its usage telemetry, because disabling feature flags hides models such
as Mythos and previous-generation models. This is a
[known Claude Code issue](https://github.com/anthropics/claude-code/issues/105923).
The probe sends no conversation history or generation request. Automatic CLI
updates, official marketplace auto-install, feedback uploads, and error reporting
remain disabled.

To opt out of discovery telemetry, set `DISABLE_TELEMETRY=1` before starting Pi.
Discovery also preserves inherited `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
`DO_NOT_TRACK`, and `DISABLE_GROWTHBOOK` settings. These can reduce the discovered
catalog; the extension does not remove them to restore missing models. Claude
Code treats any non-empty `DISABLE_TELEMETRY` or
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` value as enabled, including `0` or
`false`; unset them to allow normal discovery again. See
[Claude Code's environment variables](https://code.claude.com/docs/en/env-vars#features-that-need-feature-flag-fetching).

Conversation workers still disable telemetry and nonessential traffic regardless
of the discovery settings.

## Usage and billing

Requests made through this extension count against your Claude subscription's
usage quota and rate limits, the same as any other Claude Code usage. The
extension does not give you separate or unlimited usage.

To avoid silently changing how you're authenticated or billed, the extension
refuses to run if your environment sets an API key, proxy, Bedrock, Vertex, or
Foundry override for Claude Code.

## Limitations

- The extension is experimental.
- Branching, editing earlier messages, or changing settings mid-conversation
  starts a fresh Claude Code process that replays the conversation. The first
  response after that can be slower and may use more quota.
- Complex tool schemas (nullable types, `oneOf`, `allOf`, `anyOf`) may be
  simplified before Claude sees them.
- Adding or removing tools in the middle of a conversation keeps the prompt
  cache only on supported models. On other models it may use more quota.

For details on how the extension works internally, see
[ARCHITECTURE.md](ARCHITECTURE.md).
