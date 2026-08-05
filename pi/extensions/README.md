# Pi extensions

A small collection of [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) extensions that are general enough to be portable across machines and users. Each extension is a self-contained TypeScript module with no dependencies outside of `@earendil-works/pi-coding-agent` and the Node standard library.

## Installation

Pi auto-discovers extensions placed in either:

- `~/.pi/agent/extensions/` (global, all sessions)
- `.pi/extensions/` (project-local, current repo only)

Symlink or copy the files you want from this directory into one of those locations, then run `/reload` in a running Pi session (or just start a new one). Alternatively, if you've installed the plugin marketplace in Claude, you can configure Pi to look for extensions under `~/.claude/plugins/marketplaces/wincent-agent-plugins/` (see the [top-level README](../../README.md) for details).

See the [pi extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) for the full lifecycle, event, and API reference.

## Type-checking

A `tsconfig.json` sits alongside the extensions so that `tsc` can resolve the platform packages (`@earendil-works/pi-*`, `typebox`, `@types/node`). The matching `.d.ts` stubs live under `node_modules/`, populated on demand by `bin/install-types` (which copies them out of the globally-installed pi). We assume Pi is globally installed; Pi extensions will use the globally-installed versions of their dependencies[^jiti].

[^jiti]: Pi's loader (see `dist/core/extensions/loader.js` in the global install) loads extensions with jiti, passing a map that rewrites the specifiers to absolute paths before Node's module resolution kicks in. This means that it will always use the globally installed dependencies and won't try to load anything from the local `node_modules` directory.

The stub tree is _not_ committed: each pi release would otherwise produce a thousand-file regeneration diff that buries everything else in the history, and the bulk of the tree (`@types/node`, `typebox`) is third-party content that has no business living in this repo. The `node_modules/` directory itself is tracked, but only to anchor a `.gitignore` that ignores everything underneath it; the stubs themselves are produced locally as needed.

- Run a check from the repo root with `bin/typecheck`. If the stubs are missing (fresh checkout, or you wiped them) it will call `bin/install-types` for you automatically before invoking `tsc`.
- Refresh the stubs manually after each pi upgrade with `bin/install-types`. The script does not detect version drift on its own, so a stale tree will type-check against the previous pi's API surface until you rerun it.

`npm install` is intentionally blocked in this directory because the runtime dependency trees of the platform packages, in particular `@earendil-works/pi-ai`, pull in every supported provider SDK (Anthropic, AWS Bedrock, Google, Mistral, OpenAI) and their transitive trees. None of that is needed to type-check a handful of extension files, and at least one transitive dependency (`@mistralai/mistralai`) has been the target of supply chain attacks in the past ([MAL-2026-3432](https://osv.dev/vulnerability/MAL-2026-3432)/[GHSA-3q49-cfcf-g5fm](https://github.com/advisories/GHSA-3q49-cfcf-g5fm)).

## Extensions

### `edit-answer.ts`

Adds a `/edit-answer` slash command that opens the most recent assistant answer in `$EDITOR`. The edited buffer is dropped back into the input editor on save, which is useful for "the answer was 90% right, let me hand-tweak it and send it as the next prompt".

Append `pick` (or `--pick`) to choose from the 20 most recent answers via a selector instead of always taking the latest.

**Requires:** `$EDITOR` set to a terminal editor that takes over stdio (`vim`, `nvim`, `emacs -nw`, etc.). Falls back to `vim`. GUI editors that return immediately will not work.

### `jj-guard.ts`

Hooks the `tool_call` event and blocks raw `git add`, `git stage`, and `git commit` invocations whenever pi is running inside a Jujutsu repository (detected by walking up to a `.git` worktree root and checking for a sibling `.jj` directory).

Intended as a guardrail against LLMs that reflexively reach for git commands even when the project uses `jj` (not a security boundary; the regexes are heuristic and won't catch every obfuscated invocation).

**Requires:** `git` and (for the check to fire) a `.jj` directory in the repo root.

### `model-info.ts`

Hooks `before_agent_start` and appends a "Pi runtime" block to the system prompt on every turn:

```
## Pi runtime

- Active model: `anthropic/claude-opus-4-7` (Claude Opus 4.7)
- Active thinking level: `xhigh`
```

This gives the agent a reliable way to identify itself at runtime, which matters for skills that need accurate self-attribution. For example, the `git-commit` and `jj-commit` skills in this repo derive their `Co-Authored-By` trailer from the model identity; without this extension they fall back to a generic `AI Assistant <noreply@example.com>` line.

Because the block is regenerated every turn, `/model` and `/thinking` changes are reflected live without restarting Pi.

### `subagent/`

Delegates focused tasks to specialized subagents that run as their own Pi processes inside tmux panes, communicating with the main agent over a typed Unix domain socket bus (never via `tmux capture-pane` or `send-keys`). Ships six default agent personalities (`scout`, `linter`, `tester`, `reviewer`, `formatter`, `worker`); more can be added by dropping files into `~/.pi/agent/agents/`.

In main mode, registers `subagent`, `subagent_steer`, `subagent_cancel`, and `subagent_status` tools. In sub mode (when spawned by another Pi), registers `report`, `progress`, and `ask` tools so the child can talk back. Lifecycle events are emitted on `pi.events` under the `subagent:*` namespace.

See [`subagent/README.md`](subagent/README.md) for more.

### `datadog-mcp.ts`

Talks to Datadog's MCP server.

Registers three slash commands:

- `/datadog-login` signs in via the browser.
- `/datadog-logout` clears stored tokens for the current domain.
- `/datadog-status` shows connection status (no token material).

A companion `datadog-mcp` skill under `pi/skills/datadog-mcp/` teaches the agent the `list_tools`, `describe_tool`, and `call_tool` pattern. Mutating tools always require a confirmation prompt. The target site defaults to `mcp.datadoghq.com`, overridable via `DATADOG_MCP_DOMAIN`.

### `google-workspace-mcp.ts`

Talks to a configured Google Workspace MCP server that provides access to Google Drive, Sheets, Docs, and Slides.

Registers three slash commands:

- `/google-workspace-login` signs in through the browser using OAuth with PKCE and dynamic client registration.
- `/google-workspace-logout` clears locally stored tokens; pass `all` to also clear the dynamic client registration.
- `/google-workspace-status` shows connection status without exposing token material.

A companion `google-workspace-mcp` skill under `pi/skills/google-workspace-mcp/` teaches the agent the `list_tools`, `describe_tool`, and `call_tool` pattern. Mutating tools always require a confirmation prompt; only a local allowlist of known read operations bypasses the gate, so unknown server tools default to mutating. `GOOGLE_WORKSPACE_MCP_URL` is required. `GOOGLE_WORKSPACE_MCP_ACCOUNT_DOMAIN` optionally customizes account guidance, and the local OAuth callback port defaults to `19877` with an override available through `GOOGLE_WORKSPACE_MCP_CALLBACK_PORT`.

The dynamic client registration metadata and OAuth tokens are stored as plaintext JSON under `$PI_CODING_AGENT_DIR/google-workspace-mcp/` (default `~/.pi/agent/google-workspace-mcp/`). Directories and files are restricted to modes `0700` and `0600` on POSIX systems. This is not an OS credential store. The FastMCP v2.13 DCR flow registers a public client with `token_endpoint_auth_method=none`; the secret-based methods in the server's discovery metadata do not describe this client-facing flow.

### `slack-mcp.ts`

Uses an OAuth grant previously obtained from Claude to talk to Slack's MCP server.

Registers two slash commands:

- `/slack-status` shows status of Slack connection.
- `/slack-refresh` forces a token refresh.

A companion `slack-mcp` skill under `pi/skills/slack-mcp/` teaches the agent how to use the `list_tools`, `describe_tool`, and `call_tool` commands. Mutating tools always require a confirmation prompt.

### `context-breakdown.ts`

Adds a `/context` slash command, similar to the one from Claude Code, that shows how the current context window is being used. This is a counterpart to the built-in `/session`, which reports _cumulative_ session billing rather than current context composition, and to the footer, which reports context usage as a single opaque percentage.

The _total_ (from `ctx.getContextUsage()`) is authoritative, coming from the provider's own token count for the last assistant turn. The _categories_ are estimated from character counts; any discrepancy is reported in the "Unaccounted" category.

### `total-cost.ts`

Adds a `/total-cost` slash command that scans every saved Pi session under `$PI_CODING_AGENT_DIR/sessions` (default `~/.pi/agent/sessions`) and shows a per-month breakdown of cumulative LLM cost, message count, and number of distinct sessions. The cost is also broken down per model, with one extra column per model (ordered by total cost, descending) in the same table:

```
Month       Cost  claude-opus-4-8  gpt-5.5  Messages  Sessions
─────────────────────────────────────────────────────────────
2026-05   $42.17           $38.02    $4.15       318        24
2026-04   $89.04           $89.04        -       612        41
─────────────────────────────────────────────────────────────
Total    $131.21          $127.06    $4.15       930        65
```

It accepts two optional arguments:

- `no-model-breakdown` suppresses the per-model columns and shows totals only, for a compact view on narrow terminals.
- any other word is treated as a model-name filter: only models whose name contains one of the given substrings are counted, and the cost, message, and session columns reflect just those models. For example `/total-cost claude` restricts the table to Claude models, and `/total-cost gpt gemini` keeps both families. Filters and `no-model-breakdown` can be combined (e.g. `/total-cost claude no-model-breakdown`).

Renders as a TUI modal when running interactively, or plain text on stdout in non-interactive mode.
