/**
 * Shared MCP client core for Pi extensions that expose a hosted MCP server
 * through a single `list_tools` / `describe_tool` / `call_tool` tool.
 */

import {StringEnum} from '@earendil-works/pi-ai';
import {
  type AgentToolResult,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateHead,
} from '@earendil-works/pi-coding-agent';
import {type Static, type TSchema, Type} from 'typebox';
import {Check, Errors} from 'typebox/value';

// ── Validation helper ──────────────────────────────────────────────────────

export function describeValidationFailure(
  schema: TSchema,
  value: unknown,
): string {
  const errs = Errors(schema, value).slice(0, 3).map((e) =>
    `${e.instancePath || '(root)'}: ${e.message}`
  );
  return errs.join('; ') || 'value did not match expected schema';
}

// ── MCP schemas ─────────────────────────────────────────────────────────────

const McpToolInputSchemaSchema = Type.Object({
  type: Type.Optional(Type.String()),
  properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  required: Type.Optional(Type.Array(Type.String())),
});

const McpToolAnnotationsSchema = Type.Object({
  title: Type.Optional(Type.String()),
  readOnlyHint: Type.Optional(Type.Boolean()),
  destructiveHint: Type.Optional(Type.Boolean()),
  idempotentHint: Type.Optional(Type.Boolean()),
  openWorldHint: Type.Optional(Type.Boolean()),
});

export const McpToolSchema = Type.Object({
  name: Type.String({minLength: 1}),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  inputSchema: Type.Optional(McpToolInputSchemaSchema),
  annotations: Type.Optional(McpToolAnnotationsSchema),
});
export type McpTool = Static<typeof McpToolSchema>;

const McpToolsListResultSchema = Type.Object({
  tools: Type.Array(Type.Unknown()),
});

const McpInitializeResultSchema = Type.Object({
  protocolVersion: Type.String(),
});

// Loose JSON-RPC 2.0 response envelope. We only assert that the envelope is an
// object and, if `error` is present, that it is an object too. The inner
// `error.message` is left as `unknown` so a non-string message (out-of-spec,
// but observed in the wild) doesn't turn an upstream error into a 'malformed
// response' error.
const McpRpcResponseSchema = Type.Object({
  jsonrpc: Type.Optional(Type.String()),
  id: Type.Optional(Type.Unknown()),
  result: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.Object({
    code: Type.Optional(Type.Unknown()),
    message: Type.Optional(Type.Unknown()),
    data: Type.Optional(Type.Unknown()),
  })),
});

export function validateTools(input: unknown, maxTools: number): McpTool[] {
  if (!Check(McpToolsListResultSchema, input)) {
    throw new Error(
      `MCP tools/list returned an unexpected shape: ${
        describeValidationFailure(McpToolsListResultSchema, input)
      }`,
    );
  }
  const out: McpTool[] = [];
  // Validate per-entry rather than as a single Array(McpToolSchema): a single
  // malformed tool from upstream should not blank the whole catalog. Entries
  // that don't conform are dropped silently.
  for (const t of input.tools) {
    if (out.length >= maxTools) {
      break;
    }
    if (Check(McpToolSchema, t)) {
      out.push(t);
    }
  }
  return out;
}

// ── MCP client (JSON-RPC over Streamable HTTP) ──────────────────────────────

/**
 * Protocol versions this core is wire-compatible with, newest first.
 *
 * `initialize` advertises the caller's preferred version, but per the spec that
 * is a ceiling, not a demand: a server that doesn't speak it answers with the
 * newest version it does support, and the client may either continue on that
 * version or disconnect. Every version listed here uses the same Streamable
 * HTTP framing, the same `MCP-Protocol-Version` header, and the same
 * `tools/list` and `tools/call` payload shapes that this file relies on, so a
 * downgrade to any of them is transparent to callers.
 *
 * Versions older than 2025-03-26 are deliberately absent: they predate
 * Streamable HTTP, so the transport in this file would not work against them.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
];

export interface McpClientOptions {
  /** Human-readable name used in error messages (e.g. "Slack", "Datadog"). */
  label: string;
  /** Returns the MCP endpoint URL (may include a query string). */
  url(): string;
  /** Returns a fresh, valid access token; refresh logic lives in the caller. */
  getAccessToken(signal?: AbortSignal): Promise<string>;
  /**
   * Invoked once on a 401 before the single retry, so the caller can drop its
   * cached token (the next `getAccessToken` should re-fetch/refresh).
   */
  invalidateAuth?(): void;
  /**
   * Preferred protocol version sent in `initialize`. Acts as a maximum: if the
   * server counters with an older version from SUPPORTED_PROTOCOL_VERSIONS, the
   * session proceeds on that version instead.
   */
  protocolVersion: string;
  /** Client identity sent in `initialize`. */
  clientInfo: {name: string; version: string};
  /** Whether to POST a `notifications/initialized` after `initialize`. */
  sendInitialized?: boolean;
  /** Cap on tools returned by `listTools`. Default 200. */
  maxTools?: number;
  /** Per-request timeout. Default 30s. */
  requestTimeoutMs?: number;
  /** How long a session id is reused before re-initializing. Default 22h. */
  sessionTtlMs?: number;
}

export interface McpClient {
  listTools(signal?: AbortSignal): Promise<McpTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** Drop the cached session and tool catalog (e.g. on logout/shutdown). */
  reset(): void;
}

export function createMcpClient(opts: McpClientOptions): McpClient {
  const maxTools = opts.maxTools ?? 200;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  const sessionTtlMs = opts.sessionTtlMs ?? 22 * 60 * 60 * 1000;

  let sessionId: string | undefined;
  let sessionReady = false;
  let sessionFor: string | null = null; // accessToken the session was opened for
  let sessionOpenedAt = 0;
  let negotiatedProtocolVersion: string | null = null;
  let cachedTools: McpTool[] | null = null;
  let transportEpoch = 0;
  let transportController = new AbortController();

  function transportResetError(): Error {
    const error = new Error(`${opts.label} MCP client was reset`);
    error.name = 'AbortError';
    return error;
  }

  function assertTransportEpoch(epoch: number): void {
    if (epoch !== transportEpoch) {
      throw transportResetError();
    }
  }

  function clearSession(): void {
    sessionId = undefined;
    sessionReady = false;
    sessionFor = null;
    sessionOpenedAt = 0;
    negotiatedProtocolVersion = null;
  }

  function parseSseResponse(text: string, requestId: unknown): unknown {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') {
        continue;
      }
      const parsed: unknown = JSON.parse(data);
      if (requestId === undefined) {
        return parsed;
      }
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'id' in parsed &&
        (parsed as {id?: unknown}).id === requestId
      ) {
        return parsed;
      }
    }
    return null;
  }

  async function mcpFetch(
    accessToken: string,
    body: unknown,
    sid?: string,
    protocolVersion?: string,
    signal?: AbortSignal,
  ): Promise<{resp: Response; sessionIdOut: string | null; json: unknown}> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${accessToken}`,
    };
    if (sid) {
      headers['MCP-Session-Id'] = sid;
    }
    if (protocolVersion) {
      headers['MCP-Protocol-Version'] = protocolVersion;
    }

    const requestId = body !== null && typeof body === 'object' && 'id' in body
      ? (body as {id?: unknown}).id
      : undefined;
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    const resetSignal = transportController.signal;
    if (signal?.aborted || resetSignal.aborted) {
      ctrl.abort();
    } else {
      signal?.addEventListener('abort', abort, {once: true});
      resetSignal.addEventListener('abort', abort, {once: true});
    }
    const timer = setTimeout(() => ctrl.abort(), requestTimeoutMs);
    try {
      const resp = await fetch(opts.url(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const sessionIdOut = resp.headers.get('mcp-session-id');
      const contentType = (resp.headers.get('content-type') ?? '')
        .toLowerCase();
      let json: unknown = null;
      if (resp.ok) {
        const text = await resp.text();
        if (contentType.includes('text/event-stream')) {
          json = parseSseResponse(text, requestId);
        } else if (text) {
          json = JSON.parse(text);
        }
      }
      return {resp, sessionIdOut, json};
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resetSignal.removeEventListener('abort', abort);
    }
  }

  async function ensureSession(signal?: AbortSignal): Promise<
    {accessToken: string; sessionId?: string; protocolVersion: string}
  > {
    const epoch = transportEpoch;
    const operationSignal = signal
      ? AbortSignal.any([signal, transportController.signal])
      : transportController.signal;
    let accessToken = await opts.getAccessToken(operationSignal);
    assertTransportEpoch(epoch);
    const fresh = sessionReady && sessionFor === accessToken &&
      negotiatedProtocolVersion &&
      Date.now() - sessionOpenedAt < sessionTtlMs;
    if (fresh && negotiatedProtocolVersion) {
      return {
        accessToken,
        sessionId,
        protocolVersion: negotiatedProtocolVersion,
      };
    }

    const initialize = (token: string) =>
      mcpFetch(
        token,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: opts.protocolVersion,
            capabilities: {},
            clientInfo: opts.clientInfo,
          },
        },
        undefined,
        undefined,
        operationSignal,
      );

    let initialized = await initialize(accessToken);
    assertTransportEpoch(epoch);
    if (initialized.resp.status === 401) {
      clearSession();
      opts.invalidateAuth?.();
      accessToken = await opts.getAccessToken(operationSignal);
      assertTransportEpoch(epoch);
      initialized = await initialize(accessToken);
      assertTransportEpoch(epoch);
    }
    if (!initialized.resp.ok) {
      throw new Error(
        `${opts.label} MCP initialize failed: HTTP ${initialized.resp.status}`,
      );
    }
    const result = extractResult<unknown>(initialized.json, 'initialize');
    if (!Check(McpInitializeResultSchema, result)) {
      throw new Error(
        `${opts.label} MCP initialize returned an unexpected result: ${
          describeValidationFailure(McpInitializeResultSchema, result)
        }`,
      );
    }
    if (
      result.protocolVersion !== opts.protocolVersion &&
      !SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)
    ) {
      throw new Error(
        `${opts.label} MCP negotiated unsupported protocol version ${result.protocolVersion}; requested ${opts.protocolVersion}, and this client can also speak ${
          SUPPORTED_PROTOCOL_VERSIONS.join(', ')
        }`,
      );
    }

    if (opts.sendInitialized) {
      const notified = await mcpFetch(
        accessToken,
        {jsonrpc: '2.0', method: 'notifications/initialized', params: {}},
        initialized.sessionIdOut ?? undefined,
        result.protocolVersion,
        operationSignal,
      );
      assertTransportEpoch(epoch);
      if (!notified.resp.ok) {
        throw new Error(
          `${opts.label} MCP initialized notification failed: HTTP ${notified.resp.status}`,
        );
      }
    }
    assertTransportEpoch(epoch);
    sessionId = initialized.sessionIdOut ?? undefined;
    sessionReady = true;
    sessionFor = accessToken;
    sessionOpenedAt = Date.now();
    negotiatedProtocolVersion = result.protocolVersion;
    return {
      accessToken,
      sessionId,
      protocolVersion: result.protocolVersion,
    };
  }

  function extractResult<T>(json: unknown, method: string): T {
    if (json === null || json === undefined) {
      throw new Error(`${opts.label} MCP ${method}: empty response`);
    }
    if (!Check(McpRpcResponseSchema, json)) {
      throw new Error(
        `${opts.label} MCP ${method}: malformed JSON-RPC response: ${
          describeValidationFailure(McpRpcResponseSchema, json)
        }`,
      );
    }
    if (json.error) {
      const msg = typeof json.error.message === 'string'
        ? json.error.message
        : 'unknown error';
      throw new Error(`${opts.label} MCP ${method} error: ${msg}`);
    }
    return json.result as T;
  }

  async function rpc<T>(
    method: string,
    params: unknown = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const epoch = transportEpoch;
    const call = async (session: {
      accessToken: string;
      sessionId?: string;
      protocolVersion: string;
    }) =>
      mcpFetch(
        session.accessToken,
        {
          jsonrpc: '2.0',
          id: Math.floor(Math.random() * 1_000_000),
          method,
          params,
        },
        session.sessionId,
        session.protocolVersion,
        signal,
      );

    const session = await ensureSession(signal);
    assertTransportEpoch(epoch);
    const first = await call(session);
    assertTransportEpoch(epoch);
    if (
      first.resp.status === 401 ||
      (first.resp.status === 404 && session.sessionId !== undefined)
    ) {
      const shouldRefreshToken = first.resp.status === 401;
      clearSession();
      if (shouldRefreshToken) {
        opts.invalidateAuth?.();
      }
      const retrySession = await ensureSession(signal);
      assertTransportEpoch(epoch);
      const retry = await call(retrySession);
      assertTransportEpoch(epoch);
      if (!retry.resp.ok) {
        throw new Error(
          `${opts.label} MCP ${method} failed after retry: HTTP ${retry.resp.status}`,
        );
      }
      return extractResult<T>(retry.json, method);
    }
    if (!first.resp.ok) {
      throw new Error(
        `${opts.label} MCP ${method} failed: HTTP ${first.resp.status}`,
      );
    }
    return extractResult<T>(first.json, method);
  }

  return {
    async listTools(signal) {
      if (cachedTools) {
        return cachedTools;
      }
      const epoch = transportEpoch;
      const result = await rpc<unknown>('tools/list', {}, signal);
      assertTransportEpoch(epoch);
      const tools = validateTools(result, maxTools);
      assertTransportEpoch(epoch);
      cachedTools = tools;
      return tools;
    },
    async callTool(name, args, signal) {
      return rpc<unknown>('tools/call', {name, arguments: args}, signal);
    },
    reset() {
      transportEpoch++;
      transportController.abort();
      transportController = new AbortController();
      clearSession();
      cachedTools = null;
    },
  };
}

// ── Tool-catalog helpers ─────────────────────────────────────────────────────

export function summarizeDescription(desc: string | undefined): string {
  if (!desc) {
    return '';
  }
  const flat = desc.replace(/\s+/g, ' ').trim();
  const firstSentence = flat.match(/^.*?\.(?=\s|$)/);
  return (firstSentence ? firstSentence[0] : flat).slice(0, 240);
}

// Builds an `isWriteTool` predicate. The server's `readOnlyHint` annotation,
// when present, takes precedence; otherwise the tool name is split on common
// separators and considered mutating if any token is in `verbs`. This is
// intentionally over-inclusive: a false positive only adds a confirmation
// prompt; a false negative could let the agent mutate without a gate.
export function makeIsWriteTool(
  verbs: Set<string>,
): (tool: McpTool) => boolean {
  return (tool: McpTool): boolean => {
    const hint = tool.annotations?.readOnlyHint;
    if (hint === true) {
      return false;
    }
    if (hint === false) {
      return true;
    }
    for (const tok of tool.name.toLowerCase().split(/[._\-]+/)) {
      if (verbs.has(tok)) {
        return true;
      }
    }
    return false;
  };
}

function jsonTypeOf(v: unknown): string {
  if (v === null) {
    return 'null';
  }
  if (Array.isArray(v)) {
    return 'array';
  }
  return typeof v;
}

function matchesJsonType(v: unknown, t: string): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number';
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'null':
      return v === null;
    default:
      return true; // unknown type keyword: pass through
  }
}

// Minimal local validator for the common JSON Schema subset that MCP tool
// inputSchemas actually use: `required`, `type` (string or union), and `enum`.
// Returns null on success or a short human-readable message on the first
// failure. Anything more exotic (oneOf, $ref, pattern, etc.) is intentionally
// ignored so the upstream server still sees the call.
export function validateArgsAgainstSchema(
  args: unknown,
  schema: McpTool['inputSchema'],
): string | null {
  if (!schema) {
    return null;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'tool_args must be a JSON object';
  }
  const obj = args as Record<string, unknown>;
  for (const name of schema.required ?? []) {
    if (!(name in obj)) {
      return `missing required field '${name}'`;
    }
  }
  const props = schema.properties ?? {};
  for (const [key, value] of Object.entries(obj)) {
    const propSchema = props[key] as
      | {type?: string | string[]; enum?: unknown[]}
      | undefined;
    if (!propSchema) {
      continue;
    }
    const expected = propSchema.type;
    if (expected) {
      const types = Array.isArray(expected) ? expected : [expected];
      if (!types.some((t) => matchesJsonType(value, t))) {
        return `field '${key}' has wrong type: expected ${
          types.join('|')
        }, got ${jsonTypeOf(value)}`;
      }
    }
    if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(value)) {
      return `field '${key}' has invalid value: expected one of ${
        JSON.stringify(propSchema.enum)
      }`;
    }
  }
  return null;
}

export function unknownToolError(
  name: string,
  tools: McpTool[],
  label: string,
): string {
  const lower = name.toLowerCase();
  const tokens = lower.split(/[._\-]+/).filter(Boolean);
  const ranked = tools
    .map((t) => {
      const n = t.name.toLowerCase();
      let score = 0;
      if (n.includes(lower)) {
        score += 5;
      }
      for (const tok of tokens) {
        if (tok && n.includes(tok)) {
          score += 1;
        }
      }
      return {name: t.name, score};
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.name);
  const catalog = tools.map((t) => t.name).join(', ');
  const suggestionLine = ranked.length
    ? `Closest matches: ${ranked.join(', ')}.\n`
    : '';
  return (
    `Error: unknown ${label} tool '${name}'. Do not guess tool names.\n` +
    suggestionLine +
    `Available tools: ${catalog}\n` +
    `Use action="describe_tool" with tool_name to get the input schema before calling.`
  );
}

// ── Proxy-tool factory ────────────────────────────────────────────────────────

export type McpProxyResult = AgentToolResult<Record<string, unknown>>;

export interface ProxyToolOptions {
  /** Tool name the LLM calls (e.g. "slack", "datadog"). */
  name: string;
  /** Human-readable label for the UI and error messages. */
  label: string;
  /** Full tool description shown to the LLM. */
  description: string;
  client: McpClient;
  isWriteTool(tool: McpTool): boolean;
  /** Confirmation-dialog copy for mutating tools. */
  writeGate: {title: string};
  /**
   * Optional hook to convert a thrown error into a tool result (e.g. turn a
   * "not authenticated" sentinel into a user-facing instruction). Return
   * undefined to rethrow.
   */
  handleError?(err: unknown): McpProxyResult | undefined;
}

export function defineMcpProxyTool(opts: ProxyToolOptions) {
  return defineTool({
    name: opts.name,
    label: opts.label,
    description: opts.description,
    parameters: Type.Object({
      action: StringEnum(
        ['list_tools', 'describe_tool', 'call_tool'] as const,
        {description: 'Action to perform'},
      ),
      tool_name: Type.Optional(
        Type.String({
          description:
            `${opts.label} MCP tool name (required for describe_tool and call_tool)`,
        }),
      ),
      tool_args: Type.Optional(
        Type.Unknown({
          description:
            'Arguments for the tool call as a JSON object (required for call_tool)',
        }),
      ),
    }),

    async execute(
      _id,
      params,
      signal,
      _onUpdate,
      ctx,
    ): Promise<McpProxyResult> {
      try {
        if (params.action === 'list_tools') {
          const tools = await opts.client.listTools(signal);
          const catalog = tools.map((t) => ({
            name: t.name,
            summary: summarizeDescription(t.description),
            mutating: opts.isWriteTool(t),
          }));
          return {
            content: [{type: 'text', text: JSON.stringify(catalog, null, 2)}],
            details: {action: 'list_tools', count: tools.length},
          };
        }

        if (params.action === 'describe_tool') {
          if (!params.tool_name) {
            throw new Error('tool_name is required for describe_tool');
          }
          const tools = await opts.client.listTools(signal);
          const tool = tools.find((t) => t.name === params.tool_name);
          if (!tool) {
            throw new Error(
              unknownToolError(params.tool_name, tools, opts.label),
            );
          }
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(
                {
                  name: tool.name,
                  title: tool.title,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                  mutating: opts.isWriteTool(tool),
                },
                null,
                2,
              ),
            }],
            details: {action: 'describe_tool', tool: tool.name},
          };
        }

        if (params.action === 'call_tool') {
          if (!params.tool_name) {
            throw new Error('tool_name is required for call_tool');
          }
          const toolName = params.tool_name;
          const args = typeof params.tool_args === 'string'
            ? JSON.parse(params.tool_args)
            : ((params.tool_args as Record<string, unknown> | undefined) ?? {});

          // Validate the tool name locally against the catalog so a guessed
          // name turns into a self-healing prompt instead of a cryptic
          // upstream error.
          const tools = await opts.client.listTools(signal);
          const tool = tools.find((t) => t.name === toolName);
          if (!tool) {
            throw new Error(unknownToolError(toolName, tools, opts.label));
          }

          const validationError = validateArgsAgainstSchema(
            args,
            tool.inputSchema,
          );
          if (validationError) {
            throw new Error(
              `Invalid arguments for ${toolName}: ${validationError}. ` +
                `Use action="describe_tool" with tool_name="${toolName}" to see the full schema.`,
            );
          }

          if (opts.isWriteTool(tool)) {
            const argPreview = JSON.stringify(args, null, 2).slice(0, 1500);
            const ok = await ctx.ui.confirm(
              opts.writeGate.title,
              `pi wants to call mutating ${opts.label} tool:\n  ${toolName}\n\nArgs:\n${argPreview}`,
            );
            if (!ok) {
              throw new Error(`Blocked by user: ${toolName}`);
            }
          }

          const result = await opts.client.callTool(toolName, args, signal);
          const text = typeof result === 'string'
            ? result
            : JSON.stringify(result, null, 2);
          const truncation = truncateHead(text, {
            maxBytes: DEFAULT_MAX_BYTES,
            maxLines: DEFAULT_MAX_LINES,
          });
          const output = truncation.truncated
            ? `${truncation.content}\n\n[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines (${
              formatSize(truncation.outputBytes)
            } of ${
              formatSize(truncation.totalBytes)
            }). Refine the request to retrieve a narrower result.]`
            : truncation.content;
          return {
            content: [{type: 'text', text: output}],
            details: {
              action: 'call_tool',
              tool: toolName,
              mutating: opts.isWriteTool(tool),
              truncated: truncation.truncated,
            },
          };
        }

        throw new Error(`Unknown action: ${params.action as string}`);
      } catch (e) {
        const handled = opts.handleError?.(e);
        if (handled) {
          return handled;
        }
        throw e;
      }
    },
  });
}
