/**
 * Context Breakdown Extension
 *
 * Adds a `/context` command that shows where the current context window is
 * going, as a 100-cell map of the window (one cell per percent, colored by
 * category) plus per-category detail lists: which context files, which skills,
 * which tool schemas, and which individual messages are the expensive ones.
 *
 * Pi's own `/session` command reports *cumulative* session accounting (tokens
 * billed over the whole session) and the footer reports a single context-usage
 * percentage. Neither answers "what is actually sitting in my context window
 * right now, and which part of it is the hog?". This does.
 *
 * How the numbers are produced:
 *
 *   - The headline total comes from `ctx.getContextUsage()`, i.e. the same
 *     value the footer shows: the provider's own token count for the most
 *     recent assistant turn, plus a chars/4 estimate for any messages appended
 *     since. That number is authoritative but opaque, being a single total for
 *     the whole prompt.
 *   - The per-category split is therefore *estimated* from character counts.
 *     Pi's own chars/4 heuristic is far too generous for agent sessions, so the
 *     divisor is instead calibrated against this session's provider counts (see
 *     `calibrate`). Measured sessions land near 2 chars/token on Anthropic and
 *     3.4 on OpenAI, so a fixed divisor cannot work. Tool definitions are
 *     estimated from the JSON size of their name, description, and parameter
 *     schema; images are charged a flat approximation.
 *   - Whatever the calibrated fit still misses is shown as its own
 *     "Unaccounted" category rather than being silently spread across the
 *     others. With calibration it is typically well under 1% of the window.
 *
 * The map also shows the compaction reserve: the tail of the window that
 * auto-compaction keeps free, i.e. the point at which pi will summarize.
 *
 * Detail sections are capped by default. Pass any combination of `files`,
 * `skills`, `tools`, and `messages` to expand one, or `all` to expand
 * everything.
 *
 * Renders as a scrollable TUI modal when running interactively, or plain text
 * otherwise: on stdout in print mode, on stderr in JSON and RPC modes, where
 * stdout carries the protocol.
 */

import type {AgentMessage} from '@earendil-works/pi-agent-core';
import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
  ThemeColor,
  ToolInfo,
} from '@earendil-works/pi-coding-agent';
import {
  CONFIG_DIR_NAME,
  DynamicBorder,
  calculateContextTokens,
  getAgentDir,
  sessionEntryToContextMessages,
} from '@earendil-works/pi-coding-agent';
import type {Component, TUI} from '@earendil-works/pi-tui';
import {
  Container,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, join, sep} from 'node:path';

// Pi's own compaction heuristic: 4 characters per token, and a flat per-image
// charge. Kept in sync with ESTIMATED_IMAGE_CHARS in pi's
// core/compaction/compaction.ts. Used only as a fallback: real sessions are
// nowhere near 4 chars/token (see calibrate()).
const DEFAULT_CHARS_PER_TOKEN = 4;
const IMAGE_CHARS = 4800;

// Plausible bounds for a calibrated chars/token ratio. Dense machine output
// (base64, box drawing, escape dumps) measures below 1.3; English prose runs
// past 4. Anything outside this range means the fit was fooled by something,
// so fall back rather than report a nonsense breakdown.
const MIN_CHARS_PER_TOKEN = 0.8;
const MAX_CHARS_PER_TOKEN = 8;

// Below this spread between calibration anchors the message ratio is noise, so
// use a single pooled ratio for everything instead.
const MIN_ANCHOR_SPREAD_TOKENS = 500;

// Pi's own defaults, used when settings.json says nothing. Kept in sync with
// DEFAULT_COMPACTION_SETTINGS in pi's core/compaction/compaction.ts.
const DEFAULT_COMPACTION_ENABLED = true;
const DEFAULT_RESERVE_TOKENS = 16384;

// Wrapper text pi adds around the context-file block, each context file, and
// each skill in the system prompt. The per-block constants are only a fallback
// for when the block cannot be located in the real prompt string; any drift
// lands in the residual "instructions" row rather than corrupting a total.
const CONTEXT_BLOCK_WRAPPER =
  '\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n' +
  '</project_context>\n';
const PER_FILE_WRAPPER =
  '<project_instructions path="">\n\n</project_instructions>\n\n';
const PER_SKILL_WRAPPER =
  '  <skill>\n    <name></name>\n    <description></description>\n' +
  '    <location></location>\n  </skill>\n';
const SKILLS_PREAMBLE_MARKER =
  '\n\nThe following skills provide specialized instructions for specific tasks.';
const SKILLS_OPEN_TAG = '<available_skills>';
const SKILLS_CLOSE_TAG = '</available_skills>';
const CONTEXT_OPEN_TAG = '<project_context>';
const CONTEXT_CLOSE_TAG = '</project_context>\n';

const SECTIONS = ['files', 'skills', 'tools', 'messages', 'all'] as const;

type Section = (typeof SECTIONS)[number];

const SECTION_DESCRIPTIONS: Record<Section, string> = {
  files: 'Expand the context file list',
  skills: 'Expand the skill list',
  tools: 'Expand the tool definition list',
  messages: 'Expand the largest message list',
  all: 'Expand every detail section',
};

/** Rows shown per detail group before collapsing into "and N more". */
const COLLAPSED_ROWS = 10;
/** Cap on the largest-messages list even when expanded. */
const MAX_MESSAGE_ROWS = 50;

interface Item {
  label: string;
  chars: number;
  /** Detail groups are rendered one per distinct value, heaviest first. */
  group?: string;
  /** True when the label is a filesystem path and should be elided from the left. */
  path?: boolean;
  /**
   * Set only for things that can be registered without being sent to the
   * model, i.e. tools. `chars` then describes what enabling it would cost.
   */
  inactive?: boolean;
}

interface ConversationTally {
  messages: number;
  images: number;
  userChars: number;
  assistantTextChars: number;
  thinkingChars: number;
  toolCallChars: number;
  toolResultChars: number;
  shellChars: number;
  customChars: number;
  summaryChars: number;
  byTool: Map<string, {chars: number; count: number}>;
  items: Item[];
  /**
   * Per-message character counts, aligned with the input array, so density
   * calibration measures exactly the same content this report attributes.
   */
  perMessage: number[];
}

interface SystemTally {
  totalChars: number;
  baseChars: number;
  filesChars: number;
  skillsChars: number;
  files: Item[];
  skills: Item[];
}

interface ToolTally {
  chars: number;
  items: Item[];
  activeCount: number;
  inactiveCount: number;
}

interface Analysis {
  cwd: string;
  modelId: string;
  modelName: string;
  contextWindow: number;
  reportedTokens: number | null;
  measuredTokens: number;
  trailingTokens: number;
  trailingCount: number;
  reserveTokens: number;
  density: Density;
  system: SystemTally;
  tools: ToolTally;
  conversation: ConversationTally;
}

// ---------------------------------------------------------------------------
// Estimation helpers
// ---------------------------------------------------------------------------

/**
 * How many characters of each kind of content the provider charges one token
 * for.
 *
 * The fixed part of the prompt (base instructions, context files, the skills
 * catalogue, and the tool schemas, all resent unchanged every turn) is mostly
 * prose and tokenizes lighter than conversation content, which is mostly code
 * and tool output, so the two get separate rates.
 */
interface Density {
  fixed: number;
  message: number;
  /** False when no provider count was available and defaults were used. */
  calibrated: boolean;
}

const UNCALIBRATED: Density = {
  fixed: DEFAULT_CHARS_PER_TOKEN,
  message: DEFAULT_CHARS_PER_TOKEN,
  calibrated: false,
};

function tokens(chars: number, charsPerToken: number): number {
  return Math.ceil(chars / charsPerToken);
}

type ContentBlocks =
  | string
  | Array<{type: string; text?: string}>
  | null
  | undefined;

/** Char count for a message content field, charging images a flat rate. */
function contentChars(content: ContentBlocks): {chars: number; images: number} {
  if (content == null) {
    return {chars: 0, images: 0};
  }
  if (typeof content === 'string') {
    return {chars: content.length, images: 0};
  }
  let chars = 0;
  let images = 0;
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      chars += block.text.length;
    } else if (block.type === 'image') {
      chars += IMAGE_CHARS;
      images++;
    }
  }
  return {chars, images};
}

/** First non-empty line of a message's text, for use as a preview. */
function contentPreview(content: ContentBlocks): string {
  if (content == null) {
    return '';
  }
  const text = typeof content === 'string'
    ? content
    : content
      .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
      .join(' ');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return '';
}

// Arguments most likely to identify what a tool call was actually about.
const IDENTIFYING_ARGUMENTS = [
  'path',
  'filePath',
  'file',
  'command',
  'pattern',
  'query',
  'url',
  'name',
];

/** Short human hint for a tool call, e.g. the path it read. */
function argumentHint(args: unknown): string {
  if (!args || typeof args !== 'object') {
    return '';
  }
  const record = args as Record<string, unknown>;
  const pick = (value: unknown): string =>
    typeof value === 'string' && value.trim() ? contentPreview(value) : '';

  for (const key of IDENTIFYING_ARGUMENTS) {
    const hint = pick(record[key]);
    if (hint) {
      return hint;
    }
  }
  for (const value of Object.values(record)) {
    const hint = pick(value);
    if (hint) {
      return hint;
    }
  }
  return '';
}

const HINT_WIDTH = 44;

/**
 * Trim a label hint to a fixed budget. Paths are shortened relative to the
 * working directory first and then elided from the left, so the basename (the
 * part that identifies the file) survives.
 */
function trimHint(hint: string, cwd: string): string {
  const pathLike = hint.includes('/') && !hint.includes(' ');
  if (!pathLike) {
    return clip(hint, HINT_WIDTH, 'end');
  }
  return clip(shortenPath(hint, cwd), HINT_WIDTH, 'start');
}

/**
 * One calibration anchor: a turn where the provider told us exactly how many
 * tokens a prompt of known character length cost.
 */
interface Anchor {
  /** Prompt tokens only, excluding the response. */
  promptTokens: number;
  /** Message characters that made up that prompt, excluding the fixed part. */
  messageChars: number;
}

/**
 * Provider-reported context tokens for the most recent usable assistant
 * message, mirroring pi's own selection rules (skip aborted, errored, and
 * all-zero usage messages).
 */
function lastAssistantUsage(
  messages: AgentMessage[],
): {tokens: number; index: number} | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') {
      continue;
    }
    const assistant = message as Extract<AgentMessage, {role: 'assistant'}>;
    if (
      assistant.stopReason === 'aborted' || assistant.stopReason === 'error'
    ) {
      continue;
    }
    if (!assistant.usage) {
      continue;
    }
    const total = calculateContextTokens(assistant.usage);
    if (total > 0) {
      return {tokens: total, index: i};
    }
  }
  return undefined;
}

/**
 * Collect calibration anchors: for every usable assistant turn, the provider's
 * prompt-token count paired with the character count of the messages that made
 * up that prompt.
 *
 * `cacheRead` and `cacheWrite` are disjoint segments of the same prompt, so
 * `input + cacheRead + cacheWrite` is the prompt size whether or not caching
 * was involved. The response is deliberately excluded: it was not part of the
 * prompt being measured.
 */
function collectAnchors(
  messages: AgentMessage[],
  perMessage: number[],
): Anchor[] {
  const anchors: Anchor[] = [];
  let messageChars = 0;
  messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      const assistant = message as Extract<AgentMessage, {role: 'assistant'}>;
      const usage = assistant.usage;
      if (
        usage && assistant.stopReason !== 'aborted' &&
        assistant.stopReason !== 'error'
      ) {
        const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
        if (promptTokens > 0) {
          anchors.push({promptTokens, messageChars});
        }
      }
    }
    messageChars += perMessage[index] ?? 0;
  });
  return anchors;
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return DEFAULT_CHARS_PER_TOKEN;
  }
  return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, ratio));
}

/**
 * Work out the real chars/token density from the provider's own accounting.
 *
 * Pi's flat chars/4 heuristic is tuned for prose and is roughly twice wrong for
 * agent sessions: code, JSON, file paths, terminal output, box-drawing glyphs,
 * and base64 all tokenize much denser. Left uncorrected every category reads at
 * about half its real size and the shortfall piles up in the unaccounted
 * remainder, which is exactly the drift this is meant to explain.
 *
 * The provider gives us the answer for free. Split the prompt into the two
 * parts that tokenize differently and give each its own unknown rate:
 *
 *   - the fixed part: the system prompt and the tool schemas, which pi resends
 *     unchanged every turn. Rate `rf`, character count `fixedChars`.
 *   - the conversation. Rate `rm`, character count `messageChars`.
 *
 * Dividing characters by a rate gives tokens, so for any turn the prompt the
 * provider charged for is the sum of the two parts. Write that for two anchor
 * turns `a` and `b`, using the provider's own reported prompt token counts
 * `promptTokens_a` and `promptTokens_b`:
 *
 *     fixedChars / rf + messageChars_a / rm = promptTokens_a
 *     fixedChars / rf + messageChars_b / rm = promptTokens_b
 *
 * `fixedChars / rf` is the same in both rows, so subtracting cancels it and
 * leaves the conversation rate as the growth ratio between the anchors:
 *
 *     rm = (messageChars_b - messageChars_a) / (promptTokens_b - promptTokens_a)
 *
 * Substituting that back gives the fixed rate:
 *
 *     rf = fixedChars / (promptTokens_a - messageChars_a / rm)
 *
 * Put plainly: growth between two turns is all conversation, so the growth
 * ratio is the conversation's rate; knowing that, the earlier turn reveals the
 * fixed part's rate. Measured on a 216-turn session this reproduces the
 * provider count to within 0.5% at the current turn, against 49% low for
 * chars/4.
 */
function calibrate(anchors: Anchor[], fixedChars: number): Density {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (!first || !last || fixedChars <= 0) {
    return UNCALIBRATED;
  }

  const tokenSpread = last.promptTokens - first.promptTokens;
  const charSpread = last.messageChars - first.messageChars;

  // Too little growth between anchors to separate the two densities: pool
  // everything into a single ratio instead of dividing by near-zero.
  if (tokenSpread < MIN_ANCHOR_SPREAD_TOKENS || charSpread <= 0) {
    const pooled = clampRatio(
      (fixedChars + last.messageChars) / last.promptTokens,
    );
    return {fixed: pooled, message: pooled, calibrated: true};
  }

  const message = clampRatio(charSpread / tokenSpread);
  const fixedTokens = first.promptTokens - first.messageChars / message;
  const fixed = fixedTokens > 0
    ? clampRatio(fixedChars / fixedTokens)
    : message;
  return {fixed, message, calibrated: true};
}

/**
 * Auto-compaction reserve, or 0 when auto-compaction is off. Pi resolves this
 * through its SettingsManager, which extensions cannot reach, so read the same
 * two files with the same precedence. Project settings only count when the
 * project is trusted, matching pi.
 */
function resolveReserveTokens(
  cwd: string,
  projectTrusted: boolean,
): number {
  interface CompactionShape {
    compaction?: {enabled?: boolean; reserveTokens?: number};
  }

  const read = (path: string): CompactionShape => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as CompactionShape;
    } catch {
      return {};
    }
  };

  const global = read(join(getAgentDir(), 'settings.json'));
  const project = projectTrusted
    ? read(join(cwd, CONFIG_DIR_NAME, 'settings.json'))
    : {};
  const enabled = project.compaction?.enabled ??
    global.compaction?.enabled ??
    DEFAULT_COMPACTION_ENABLED;
  if (!enabled) {
    return 0;
  }
  return project.compaction?.reserveTokens ??
    global.compaction?.reserveTokens ??
    DEFAULT_RESERVE_TOKENS;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Split the real system prompt string into base instructions, the context
 * file block, and the skills block.
 *
 * The block sizes are read off the actual prompt wherever the markers can be
 * found, so the three parts always add up to the true prompt length. Per-item
 * sizes come from the prompt-building options, which is the only place the
 * individual file contents are still available.
 */
function analyzeSystemPrompt(
  prompt: string,
  options: BuildSystemPromptOptions | undefined,
): SystemTally {
  const files: Item[] = (options?.contextFiles ?? []).map((file) => ({
    label: file.path,
    chars: file.content.length + file.path.length + PER_FILE_WRAPPER.length,
    path: true,
  }));

  // Pi only advertises skills when the read tool is active, since loading a
  // skill means reading its SKILL.md.
  const selectedTools = options?.selectedTools;
  const skillsAdvertised = !selectedTools || selectedTools.includes('read');
  const skills: Item[] = skillsAdvertised
    ? (options?.skills ?? [])
      .filter((skill) => !skill.disableModelInvocation)
      .map((skill) => ({
        label: skill.name,
        group: titleCase(skill.sourceInfo?.scope ?? 'other'),
        chars: skill.name.length +
          skill.description.length +
          skill.filePath.length +
          PER_SKILL_WRAPPER.length,
      }))
    : [];

  const sumOf = (items: Item[]) =>
    items.reduce((total, item) => total + item.chars, 0);

  /**
   * Spread a block's shared overhead (the `<project_context>` wrapper, the
   * skills preamble) across its items in proportion to their size. That
   * overhead exists only because the items do, so charging them for it is both
   * defensible and what makes every level of the report reconcile: items sum
   * to their group, groups sum to the section, and the section matches the
   * category shown in the legend.
   */
  const distribute = (items: Item[], total: number): Item[] => {
    const sum = sumOf(items);
    if (sum <= 0 || total <= 0) {
      return items;
    }
    const factor = total / sum;
    return items.map((item) => ({...item, chars: item.chars * factor}));
  };

  let filesChars = 0;
  if (files.length > 0) {
    const start = prompt.indexOf(CONTEXT_OPEN_TAG);
    const end = prompt.indexOf(CONTEXT_CLOSE_TAG);
    filesChars = start !== -1 && end > start
      ? end + CONTEXT_CLOSE_TAG.length - start
      : sumOf(files) + CONTEXT_BLOCK_WRAPPER.length;
  }

  let skillsChars = 0;
  if (skills.length > 0) {
    const preamble = prompt.indexOf(SKILLS_PREAMBLE_MARKER);
    const start = preamble !== -1 ? preamble : prompt.indexOf(SKILLS_OPEN_TAG);
    const end = prompt.indexOf(SKILLS_CLOSE_TAG);
    skillsChars = start !== -1 && end > start
      ? end + SKILLS_CLOSE_TAG.length - start
      : sumOf(skills) + SKILLS_PREAMBLE_MARKER.length;
  }

  return {
    totalChars: prompt.length,
    baseChars: Math.max(0, prompt.length - filesChars - skillsChars),
    filesChars,
    skillsChars,
    files: distribute(files, filesChars).sort((a, b) => b.chars - a.chars),
    skills: distribute(skills, skillsChars).sort((a, b) => b.chars - a.chars),
  };
}

/** Human label for where a tool came from, used to group the detail list. */
function toolGroup(tool: ToolInfo): string {
  const source = tool.sourceInfo?.source;
  if (!source || source === 'builtin') {
    return 'Built-in';
  }
  if (source === 'sdk') {
    return 'SDK';
  }
  // Single-file extensions are named by their file; directory-style ones live
  // in `<name>/index.ts` or `<name>/src/index.ts`, where neither the file name
  // nor the intermediate directory says anything useful.
  const uninformative = new Set(['index', 'src', 'dist', 'lib']);
  let path = tool.sourceInfo?.path ?? source;
  let name = basename(path).replace(/\.[cm]?[jt]s$/, '');
  while (uninformative.has(name) && dirname(path) !== path) {
    path = dirname(path);
    name = basename(path);
  }
  return name;
}

/**
 * Tool definitions travel alongside the prompt rather than inside it, so they
 * are estimated from the JSON size of what gets serialized for the provider:
 * name, description, and parameter schema.
 */
function analyzeTools(all: ToolInfo[], active: string[]): ToolTally {
  const activeSet = new Set(active);
  const items: Item[] = [];
  let chars = 0;
  let activeCount = 0;

  for (const tool of all) {
    let size: number;
    try {
      size = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length;
    } catch {
      // Unserializable schema (cyclic, exotic values): fall back to the parts
      // we can measure so the tool is not silently free.
      size = tool.name.length + tool.description.length;
    }
    // Inactive tools are still listed, because "what would it cost me to turn
    // this back on" is the question their presence raises, but they are not
    // sent to the model and so are excluded from every total.
    const inactive = !activeSet.has(tool.name);
    if (!inactive) {
      chars += size;
      activeCount++;
    }
    items.push({
      label: tool.name,
      chars: size,
      group: toolGroup(tool),
      inactive,
    });
  }

  return {
    chars,
    items: items.sort((a, b) =>
      Number(a.inactive) - Number(b.inactive) || b.chars - a.chars
    ),
    activeCount,
    inactiveCount: items.length - activeCount,
  };
}

function analyzeConversation(
  messages: AgentMessage[],
  cwd: string,
): ConversationTally {
  const tally: ConversationTally = {
    messages: 0,
    images: 0,
    userChars: 0,
    assistantTextChars: 0,
    thinkingChars: 0,
    toolCallChars: 0,
    toolResultChars: 0,
    shellChars: 0,
    customChars: 0,
    summaryChars: 0,
    byTool: new Map(),
    items: [],
    perMessage: messages.map(() => 0),
  };

  // Tool results carry no hint of what they were for, so borrow one from the
  // call that produced them. Calls always precede their results.
  const hintByToolCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    const assistant = message as Extract<AgentMessage, {role: 'assistant'}>;
    for (const block of assistant.content ?? []) {
      if (block.type === 'toolCall') {
        const hint = argumentHint(block.arguments);
        if (hint) {
          hintByToolCallId.set(block.id, hint);
        }
      }
    }
  }

  messages.forEach((message, index) => {
    let chars = 0;
    let label = `#${index + 1} ${message.role}`;

    switch (message.role) {
      case 'user': {
        const user = message as Extract<AgentMessage, {role: 'user'}>;
        const {chars: c, images} = contentChars(user.content as ContentBlocks);
        tally.userChars += c;
        tally.images += images;
        chars = c;
        label += ` ${
          trimHint(contentPreview(user.content as ContentBlocks), cwd)
        }`;
        break;
      }
      case 'assistant': {
        const assistant = message as Extract<AgentMessage, {role: 'assistant'}>;
        const names: string[] = [];
        let preview = '';
        for (const block of assistant.content ?? []) {
          if (block.type === 'text') {
            tally.assistantTextChars += block.text.length;
            chars += block.text.length;
            preview = preview || contentPreview([block]);
          } else if (block.type === 'thinking') {
            tally.thinkingChars += block.thinking.length;
            chars += block.thinking.length;
          } else if (block.type === 'toolCall') {
            const size = block.name.length +
              JSON.stringify(block.arguments).length;
            tally.toolCallChars += size;
            chars += size;
            names.push(block.name);
          }
        }
        label += names.length > 0
          ? ` calls ${trimHint(names.join(', '), cwd)}`
          : ` ${trimHint(preview, cwd)}`;
        break;
      }
      case 'toolResult': {
        const result = message as Extract<AgentMessage, {role: 'toolResult'}>;
        const {chars: c, images} = contentChars(
          result.content as ContentBlocks,
        );
        tally.toolResultChars += c;
        tally.images += images;
        chars = c;
        const hint = hintByToolCallId.get(result.toolCallId) ?? '';
        label = `#${index + 1} ${result.toolName} ${
          hint ? trimHint(hint, cwd) : ''
        }`;
        const bucket = tally.byTool.get(result.toolName) ??
          {chars: 0, count: 0};
        bucket.chars += c;
        bucket.count++;
        tally.byTool.set(result.toolName, bucket);
        break;
      }
      case 'bashExecution': {
        const shell = message as Extract<AgentMessage, {role: 'bashExecution'}>;
        if (shell.excludeFromContext) {
          return; // `!!` commands never reach the LLM.
        }
        chars = shell.command.length + shell.output.length;
        tally.shellChars += chars;
        label = `#${index + 1} shell ${trimHint(shell.command, cwd)}`;
        break;
      }
      case 'custom': {
        const custom = message as Extract<AgentMessage, {role: 'custom'}>;
        const {chars: c, images} = contentChars(
          custom.content as ContentBlocks,
        );
        tally.customChars += c;
        tally.images += images;
        chars = c;
        label = `#${index + 1} custom ${trimHint(custom.customType, cwd)}`;
        break;
      }
      case 'compactionSummary':
      case 'branchSummary': {
        const summary = message as Extract<
          AgentMessage,
          {role: 'compactionSummary' | 'branchSummary'}
        >;
        chars = summary.summary.length;
        tally.summaryChars += chars;
        break;
      }
      default:
        return;
    }

    tally.messages++;
    tally.perMessage[index] = chars;
    if (chars > 0) {
      tally.items.push({label: label.trimEnd(), chars});
    }
  });

  tally.items.sort((a, b) => b.chars - a.chars);
  return tally;
}

function analyze(pi: ExtensionAPI, ctx: ExtensionCommandContext): Analysis {
  const usage = ctx.getContextUsage();
  const model = ctx.model;
  const entries = ctx.sessionManager.buildContextEntries();
  const messages = entries.flatMap((entry) =>
    sessionEntryToContextMessages(entry)
  );

  const measured = lastAssistantUsage(messages);
  const conversation = analyzeConversation(messages, ctx.cwd);
  const reportedTokens = usage?.tokens ?? null;

  // Pi builds its reported figure as "provider count at the last assistant
  // turn" + "estimate for everything after it", so recover the second term by
  // subtraction. Estimating it again here would round differently and the
  // parts would stop adding up to the headline.
  const measuredTokens = measured?.tokens ?? 0;
  const trailingTokens = reportedTokens !== null && measured
    ? Math.max(0, reportedTokens - measuredTokens)
    : 0;
  const trailingCount = measured ? messages.length - 1 - measured.index : 0;

  const system = analyzeSystemPrompt(
    ctx.getSystemPrompt(),
    ctx.getSystemPromptOptions(),
  );
  const tools = analyzeTools(pi.getAllTools(), pi.getActiveTools());

  return {
    cwd: ctx.cwd,
    modelId: model ? `${model.provider}/${model.id}` : 'unknown',
    modelName: model?.name ?? '',
    contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
    reportedTokens,
    measuredTokens,
    trailingTokens,
    trailingCount,
    reserveTokens: resolveReserveTokens(ctx.cwd, ctx.isProjectTrusted()),
    density: calibrate(
      collectAnchors(messages, conversation.perMessage),
      system.totalChars + tools.chars,
    ),
    system,
    tools,
    conversation,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Compact token count: 812, 1.4k, 137.2k, 1M. */
function fmtTokens(n: number): string {
  const strip = (value: string) => value.replace(/\.0$/, '');
  if (Math.abs(n) < 1000) {
    return `${n}`;
  }
  if (Math.abs(n) < 1_000_000) {
    return `${strip((n / 1000).toFixed(1))}k`;
  }
  return `${strip((n / 1_000_000).toFixed(1))}M`;
}

function fmtPercent(value: number, total: number): string {
  if (total <= 0) {
    return '-';
  }
  return `${((value / total) * 100).toFixed(1)}%`;
}

function titleCase(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** Shorten a path for display: relative to cwd, or `~` for the home dir. */
function shortenPath(path: string, cwd: string): string {
  if (path.startsWith(cwd + sep)) {
    return path.slice(cwd.length + 1);
  }
  const home = homedir();
  if (path === home || path.startsWith(home + sep)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/**
 * Clip plain text to a visible width, eliding from whichever side matters
 * less: the tail for prose, the head for paths (where the basename is the
 * informative part).
 *
 * pi-tui's `truncateToWidth` would do this, but it wraps the ellipsis in ANSI
 * reset codes, which leak as literal escapes into non-interactive output.
 */
function clip(text: string, maxWidth: number, side: 'start' | 'end'): string {
  if (visibleWidth(text) <= maxWidth) {
    return text;
  }
  const budget = Math.max(1, maxWidth - 1);
  const characters = [...text];
  let kept = '';
  if (side === 'end') {
    for (const character of characters) {
      if (visibleWidth(kept + character) > budget) {
        break;
      }
      kept += character;
    }
    return `${kept}…`;
  }
  for (let i = characters.length - 1; i >= 0; i--) {
    if (visibleWidth(characters[i] + kept) > budget) {
      break;
    }
    kept = characters[i] + kept;
  }
  return `…${kept}`;
}

function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

const CELL_USED = '⛁';
const CELL_PARTIAL = '⛀';
const CELL_FREE = '⛶';
const CELL_RESERVE = '⛝';
const GRID_COLUMNS = 10;
const GRID_ROWS = 10;
const GRID_CELLS = GRID_COLUMNS * GRID_ROWS;
const GRID_GAP = '   ';

interface Category {
  label: string;
  tokens: number;
  color: ThemeColor;
  glyph: string;
  /** Categories that are part of the used region, in map fill order. */
  used: boolean;
}

interface CategoryGlyphs {
  system: string;
  files: string;
  skills: string;
  tools: string;
  conversation: string;
  unaccounted: string;
  free: string;
  reserve: string;
}

/**
 * Colored themes distinguish the used categories by hue, so they can all share
 * one cell glyph. Without a theme there is no hue, and the map would be a wall
 * of identical cells, so each category gets its own letter instead.
 */
function categoryGlyphs(colored: boolean): CategoryGlyphs {
  if (!colored) {
    return {
      system: 'p',
      files: 'c',
      skills: 'k',
      tools: 't',
      conversation: 'm',
      unaccounted: '?',
      free: '.',
      reserve: 'r',
    };
  }
  return {
    system: CELL_USED,
    files: CELL_USED,
    skills: CELL_USED,
    tools: CELL_USED,
    conversation: CELL_USED,
    unaccounted: CELL_USED,
    free: CELL_FREE,
    reserve: CELL_RESERVE,
  };
}

/**
 * Assign each cell to the category covering its midpoint. Categories smaller
 * than half a cell vanish from the map but still appear in the legend, which
 * is the honest outcome: they are not visible at this resolution.
 */
function buildGrid(
  categories: Category[],
  windowTokens: number,
  usedTokens: number,
): Array<{glyph: string; color: ThemeColor}> {
  const perCell = windowTokens / GRID_CELLS;
  const bounds: Array<{end: number; category: Category}> = [];
  let cursor = 0;
  for (const category of categories) {
    cursor += category.tokens;
    bounds.push({end: cursor, category});
  }
  const last = bounds[bounds.length - 1];

  const grid = [];
  for (let cell = 0; cell < GRID_CELLS; cell++) {
    const midpoint = (cell + 0.5) * perCell;
    const hit = bounds.find((bound) => midpoint < bound.end) ?? last;
    grid.push({glyph: hit.category.glyph, color: hit.category.color});
  }

  // Mark the boundary cell so a partly consumed percent reads as partly
  // consumed rather than rounding away in either direction.
  const fullCells = Math.floor(usedTokens / perCell);
  if (usedTokens % perCell !== 0 && fullCells < GRID_CELLS) {
    const lastUsed = [...categories].reverse().find(
      (category) => category.used && category.tokens > 0,
    );
    if (lastUsed) {
      grid[fullCells] = {
        glyph: lastUsed.glyph === CELL_USED ? CELL_PARTIAL : lastUsed.glyph,
        color: lastUsed.color,
      };
    }
  }

  return grid;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Accumulates themed lines. Every emitter goes through here so that plain-text
 * (non-interactive) output and TUI output cannot drift apart.
 */
class Report {
  readonly lines: string[] = [];

  constructor(private readonly theme: Theme | null) {}

  paint(color: ThemeColor, text: string): string {
    return this.theme ? this.theme.fg(color, text) : text;
  }

  private strong(text: string): string {
    return this.theme ? this.theme.bold(text) : text;
  }

  push(line: string): void {
    this.lines.push(line);
  }

  blank(): void {
    this.lines.push('');
  }

  title(text: string): void {
    this.lines.push(this.strong(this.paint('accent', text)));
  }

  heading(text: string): void {
    this.lines.push(this.strong(text));
  }

  subheading(text: string): void {
    this.lines.push(this.paint('muted', text));
  }

  note(text: string): void {
    this.lines.push(this.paint('dim', text));
  }

  warn(text: string): void {
    this.lines.push(this.paint('warning', text));
  }

  /** `├ label: 1.4k tokens`, with `└` on the final row. */
  tree(label: string, value: string, last: boolean): void {
    this.lines.push(
      `${this.paint('dim', last ? '└' : '├')} ${label}${
        this.paint('dim', ':')
      } ${this.paint('muted', value)}`,
    );
  }
}

/**
 * `3 files / 3.3k tokens / 0.3%` for a section or group heading. `total`, when
 * it differs from `count`, marks a partial population: tools that are
 * registered but not currently sent to the model.
 */
function meta(options: {
  count: number;
  total?: number;
  noun: string;
  chars: number;
  window: number;
  ratio: number;
}): string {
  const {count, total, noun, chars, window, ratio} = options;
  const plural = (total ?? count) === 1 ? noun : `${noun}s`;
  const population = total !== undefined && total !== count
    ? `${count} of ${total} ${plural} active`
    : `${count} ${plural}`;
  const value = tokens(chars, ratio);
  return `${population} / ${fmtTokens(value)} tokens / ${
    fmtPercent(value, window)
  }`;
}

/** Marker showing whether a tool is currently sent to the model. */
function activityMarker(report: Report, item: Item): string {
  if (item.inactive === undefined) {
    return '';
  }
  return item.inactive
    ? `${report.paint('dim', '○')} `
    : `${report.paint('success', '●')} `;
}

/**
 * Render a capped, tree-shaped list of items. Returns the number of rows that
 * were collapsed into the trailing summary row.
 */
function treeItems(
  report: Report,
  items: Item[],
  cwd: string,
  limit: number,
  ratio: number,
): number {
  const shown = items.slice(0, limit);
  const hidden = items.length - shown.length;
  shown.forEach((item, index) => {
    const text = item.path ? shortenPath(item.label, cwd) : item.label;
    const label = activityMarker(report, item) +
      (item.inactive ? report.paint('dim', text) : text);
    const value = fmtTokens(tokens(item.chars, ratio));
    report.tree(
      label,
      item.inactive ? `${value} tokens if enabled` : `${value} tokens`,
      hidden === 0 && index === shown.length - 1,
    );
  });
  if (hidden > 0) {
    report.tree(
      report.paint('dim', `and ${hidden} more`),
      `${fmtTokens(tokens(sumChars(items.slice(limit)), ratio))} tokens`,
      true,
    );
  }
  return hidden;
}

/** Total estimated cost of the given items, ignoring anything not sent. */
function sumChars(items: Item[]): number {
  return items.reduce(
    (total, item) => total + (item.inactive ? 0 : item.chars),
    0,
  );
}

function countActive(items: Item[]): number {
  return items.filter((item) => !item.inactive).length;
}

/** Group items by their `group` field, heaviest group first. */
function groupItems(items: Item[]): Array<[string, Item[]]> {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = item.group ?? '';
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return [...groups.entries()].sort(
    (a, b) => sumChars(b[1]) - sumChars(a[1]),
  );
}

/** Hint telling the user how to see the rows that were collapsed away. */
function expandHint(report: Report, section: Section, hidden: number): void {
  if (hidden > 0) {
    report.note(`Run \`/context ${section}\` to see all ${section}.`);
  }
}

function detailSection(options: {
  report: Report;
  title: string;
  /** Total for the whole section, which may exceed the sum of its items when
   * the category carries shared overhead (block wrappers, preambles). */
  chars: number;
  noun: string;
  section: Section;
  items: Item[];
  cwd: string;
  window: number;
  ratio: number;
  expanded: boolean;
  /** Dim line explaining any row markers, shown under the heading. */
  legend?: string;
}): void {
  const {report, items, cwd, window, noun, ratio} = options;
  if (items.length === 0) {
    return;
  }
  const limit = options.expanded ? items.length : COLLAPSED_ROWS;
  const withInactive = items.some((item) => item.inactive !== undefined);
  const groups = groupItems(items);

  // A lone group would just restate the section, so name it in the heading
  // instead of giving it a heading of its own.
  const soleGroup = groups.length === 1 && groups[0][0] !== ''
    ? groups[0][0]
    : '';

  report.blank();
  report.heading(
    `${options.title}${soleGroup ? ` · ${soleGroup}` : ''} (${
      meta({
        count: countActive(items),
        total: withInactive ? items.length : undefined,
        noun,
        chars: options.chars,
        window,
        ratio,
      })
    })`,
  );
  if (options.legend) {
    report.note(options.legend);
  }

  let hidden = 0;
  for (const [name, bucket] of groups) {
    if (groups.length > 1) {
      report.blank();
      report.subheading(
        `${name || 'Other'} (${
          meta({
            count: countActive(bucket),
            total: withInactive ? bucket.length : undefined,
            noun,
            chars: sumChars(bucket),
            window,
            ratio,
          })
        })`,
      );
    }
    hidden += treeItems(report, bucket, cwd, limit, ratio);
  }
  expandHint(report, options.section, hidden);
}

function buildReport(
  analysis: Analysis,
  sections: Set<Section>,
  theme: Theme | null,
): string[] {
  const report = new Report(theme);
  const {system, tools, conversation, cwd} = analysis;

  const conversationChars = conversation.userChars +
    conversation.assistantTextChars +
    conversation.thinkingChars +
    conversation.toolCallChars +
    conversation.toolResultChars +
    conversation.shellChars +
    conversation.customChars +
    conversation.summaryChars;
  // The fixed part of the prompt and the conversation tokenize at different
  // densities, so each is converted with its own calibrated rate.
  const {fixed, message} = analysis.density;
  const estimated = tokens(system.totalChars + tools.chars, fixed) +
    tokens(conversationChars, message);

  // The provider count is authoritative where it exists, but it is a single
  // opaque total, so the categories are estimates and "Unaccounted" carries
  // the difference. If the estimate overshoots the provider count there is
  // nothing to attribute, and the estimate becomes the total.
  const used = Math.max(estimated, analysis.reportedTokens ?? 0);
  const unaccounted = used - estimated;
  const window = analysis.contextWindow;
  const reserve = Math.min(analysis.reserveTokens, Math.max(0, window - used));
  const free = Math.max(0, window - used - reserve);

  const glyphs = categoryGlyphs(theme !== null);
  // Heaviest first, so map order matches legend order and the eye can walk the
  // cells left to right down the legend. Free space and the reserve always
  // come last: they are the tail of the window, not competitors for it.
  const usedCategories: Category[] = [{
    label: 'System prompt',
    tokens: tokens(system.baseChars, fixed),
    color: 'mdLink',
    glyph: glyphs.system,
    used: true,
  }, {
    label: 'Context files',
    tokens: tokens(system.filesChars, fixed),
    color: 'error',
    glyph: glyphs.files,
    used: true,
  }, {
    label: 'Skills',
    tokens: tokens(system.skillsChars, fixed),
    color: 'warning',
    glyph: glyphs.skills,
    used: true,
  }, {
    label: 'Tool definitions',
    tokens: tokens(tools.chars, fixed),
    color: 'success',
    glyph: glyphs.tools,
    used: true,
  }, {
    label: 'Conversation',
    tokens: tokens(conversationChars, message),
    color: 'customMessageLabel',
    glyph: glyphs.conversation,
    used: true,
  }];
  if (unaccounted > 0) {
    usedCategories.push({
      label: 'Unaccounted',
      tokens: unaccounted,
      color: 'muted',
      glyph: glyphs.unaccounted,
      used: true,
    });
  }
  usedCategories.sort((a, b) => b.tokens - a.tokens);

  const categories: Category[] = [...usedCategories, {
    label: 'Free space',
    tokens: free,
    color: 'dim',
    glyph: glyphs.free,
    used: false,
  }];
  if (reserve > 0) {
    categories.push({
      label: 'Compaction reserve',
      tokens: reserve,
      color: 'muted',
      glyph: glyphs.reserve,
      used: false,
    });
  }

  // Left column: the map. Right column: identity, total, and legend.
  const left: string[] = [];
  if (window > 0) {
    const grid = buildGrid(categories, window, used);
    for (let row = 0; row < GRID_ROWS; row++) {
      const cells = grid.slice(row * GRID_COLUMNS, (row + 1) * GRID_COLUMNS);
      left.push(
        cells.map((cell) => report.paint(cell.color, cell.glyph)).join(' '),
      );
    }
  }

  const approx = analysis.reportedTokens === null ? '~' : '';
  const right: string[] = [];
  if (analysis.modelName) {
    right.push(analysis.modelName);
  }
  right.push(report.paint('muted', analysis.modelId));
  right.push(
    `${approx}${fmtTokens(used)}/${fmtTokens(window)} tokens ` +
      report.paint('muted', `(${fmtPercent(used, window)})`),
  );
  if (analysis.reportedTokens === null) {
    right.push(report.paint('dim', 'no provider count yet; total estimated'));
  } else if (analysis.trailingCount > 0) {
    right.push(
      report.paint(
        'dim',
        `${fmtTokens(analysis.trailingTokens)} of that estimated ` +
          `(${analysis.trailingCount} new message(s))`,
      ),
    );
  }
  right.push('');
  right.push(report.paint('muted', 'Estimated usage by category'));
  for (const category of categories) {
    right.push(
      `${report.paint(category.color, category.glyph)} ${category.label}` +
        report.paint('dim', ':') +
        ` ${fmtTokens(category.tokens)} tokens ` +
        report.paint('muted', `(${fmtPercent(category.tokens, window)})`),
    );
  }

  report.title('Context Usage');
  report.blank();
  const gridWidth = GRID_COLUMNS * 2 - 1;
  for (let row = 0; row < Math.max(left.length, right.length); row++) {
    const cells = left[row] ?? '';
    const info = right[row] ?? '';
    report.push((padEnd(cells, gridWidth) + GRID_GAP + info).trimEnd());
  }

  detailSection({
    report,
    title: 'Context files',
    chars: system.filesChars,
    noun: 'file',
    section: 'files',
    items: system.files,
    cwd,
    window,
    ratio: fixed,
    expanded: sections.has('files'),
  });
  detailSection({
    report,
    title: 'Skills',
    chars: system.skillsChars,
    noun: 'skill',
    section: 'skills',
    items: system.skills,
    cwd,
    window,
    ratio: fixed,
    expanded: sections.has('skills'),
  });
  detailSection({
    report,
    title: 'Tool definitions',
    chars: tools.chars,
    noun: 'tool',
    section: 'tools',
    items: tools.items,
    cwd,
    window,
    ratio: fixed,
    expanded: sections.has('tools'),
    legend: tools.inactiveCount > 0
      ? '● sent to the model every turn   ' +
        '○ registered but switched off, so free'
      : undefined,
  });

  const conversationParts: Item[] = [
    {label: 'Tool results', chars: conversation.toolResultChars},
    {label: 'Assistant text', chars: conversation.assistantTextChars},
    {label: 'Assistant thinking', chars: conversation.thinkingChars},
    {label: 'Tool calls', chars: conversation.toolCallChars},
    {label: 'User messages', chars: conversation.userChars},
    {label: 'Shell (! commands)', chars: conversation.shellChars},
    {label: 'Extension messages', chars: conversation.customChars},
    {label: 'Compaction summaries', chars: conversation.summaryChars},
  ]
    .filter((part) => part.chars > 0)
    .sort((a, b) => b.chars - a.chars);
  if (conversationParts.length > 0) {
    report.blank();
    report.heading(
      `Conversation (${
        meta({
          count: conversation.messages,
          noun: 'message',
          chars: conversationChars,
          window,
          ratio: message,
        })
      })`,
    );
    treeItems(
      report,
      conversationParts,
      cwd,
      conversationParts.length,
      message,
    );
  }

  if (conversation.byTool.size > 0) {
    const byTool: Item[] = [...conversation.byTool.entries()]
      .sort((a, b) => b[1].chars - a[1].chars)
      .map(([name, bucket]) => ({
        label: `${name} (${bucket.count} ${
          bucket.count === 1 ? 'result' : 'results'
        })`,
        chars: bucket.chars,
      }));
    const results = [...conversation.byTool.values()].reduce(
      (total, bucket) => total + bucket.count,
      0,
    );
    report.blank();
    report.heading(
      `Tool results by tool (${
        meta({
          count: results,
          noun: 'result',
          chars: conversation.toolResultChars,
          window,
          ratio: message,
        })
      })`,
    );
    treeItems(report, byTool, cwd, byTool.length, message);
  }

  if (conversation.items.length > 0) {
    const expanded = sections.has('messages');
    report.blank();
    report.heading('Largest messages');
    const hidden = treeItems(
      report,
      conversation.items,
      cwd,
      expanded ? MAX_MESSAGE_ROWS : COLLAPSED_ROWS,
      message,
    );
    if (!expanded) {
      expandHint(report, 'messages', hidden);
    }
  }

  report.blank();
  report.note(
    'Each map cell is 1% of the window. The total is the provider count for',
  );
  report.note(
    "the last assistant turn (including that response's output) plus an",
  );
  report.note('estimate for anything appended since.');
  if (analysis.density.calibrated) {
    report.note(
      `Category sizes are character counts divided by ${
        message.toFixed(2)
      } chars/token for`,
    );
    report.note(
      `conversation and ${
        fixed.toFixed(2)
      } for the system prompt and tool schemas, both`,
    );
    report.note(
      "measured against this session's own provider counts, since code and tool",
    );
    report.note(
      'output tokenize denser than prose. Unaccounted is what that fit misses.',
    );
  } else {
    report.note(
      `No provider count yet, so categories fall back to ${DEFAULT_CHARS_PER_TOKEN} chars/token,`,
    );
    report.note(
      'which typically under-counts code and tool output by around half.',
    );
  }
  if (analysis.reserveTokens > 0) {
    report.note(
      'Compaction reserve is the tail of the window auto-compaction keeps free.',
    );
  }
  if (conversation.images > 0) {
    report.note(
      `${conversation.images} image(s) charged at ${
        fmtTokens(tokens(IMAGE_CHARS, message))
      } tokens each.`,
    );
  }
  if (window <= 0) {
    report.warn('No context window is known for the active model.');
  }

  return report.lines;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Scrolling viewport over a fixed list of pre-rendered lines. */
class Pager implements Component {
  private top = 0;

  constructor(
    private readonly lines: string[],
    private readonly height: () => number,
    private readonly onScroll: () => void,
    private readonly onClose: () => void,
  ) {}

  invalidate(): void {}

  private clamp(): void {
    const maxTop = Math.max(0, this.lines.length - this.visibleCount());
    this.top = Math.min(Math.max(0, this.top), maxTop);
  }

  visibleCount(): number {
    return Math.max(1, Math.min(this.lines.length, this.height()));
  }

  /** 1-based inclusive range of currently visible lines, plus the total. */
  position(): {
    first: number;
    last: number;
    total: number;
    scrollable: boolean;
  } {
    const visible = this.visibleCount();
    return {
      first: this.top + 1,
      last: Math.min(this.lines.length, this.top + visible),
      total: this.lines.length,
      scrollable: this.lines.length > visible,
    };
  }

  render(width: number): string[] {
    this.clamp();
    return this.lines
      .slice(this.top, this.top + this.visibleCount())
      .map((line) => truncateToWidth(line, width, '…'));
  }

  handleInput(data: string): void {
    const page = Math.max(1, this.visibleCount() - 1);
    const before = this.top;

    if (
      matchesKey(data, 'enter') || matchesKey(data, 'escape') ||
      matchesKey(data, 'q')
    ) {
      this.onClose();
      return;
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'j')) {
      this.top++;
    } else if (matchesKey(data, 'up') || matchesKey(data, 'k')) {
      this.top--;
    } else if (
      matchesKey(data, 'pageDown') || matchesKey(data, 'ctrl+f') ||
      matchesKey(data, 'space')
    ) {
      this.top += page;
    } else if (matchesKey(data, 'pageUp') || matchesKey(data, 'ctrl+b')) {
      this.top -= page;
    } else if (matchesKey(data, 'home') || matchesKey(data, 'g')) {
      this.top = 0;
    } else if (matchesKey(data, 'end') || matchesKey(data, 'shift+g')) {
      this.top = this.lines.length;
    } else {
      return;
    }

    this.clamp();
    if (this.top !== before) {
      this.onScroll();
    }
  }
}

/** Indents the pager by one column, matching pi's other modal content. */
class PaddedPager implements Component {
  constructor(private readonly pager: Pager) {}

  invalidate(): void {
    this.pager.invalidate();
  }

  render(width: number): string[] {
    return this.pager
      .render(Math.max(1, width - 1))
      .map((line) => ` ${line}`);
  }
}

class ReportViewer extends Container {
  private readonly pager: Pager;
  private readonly status = new Text('', 1, 0);

  constructor(lines: string[], tui: TUI, theme: Theme, done: () => void) {
    super();

    // Leave room for the frame, the status line, and pi's own footer so the
    // top of the report does not scroll out of the terminal's viewport.
    const height = () => Math.max(6, tui.terminal.rows - 8);

    this.pager = new Pager(
      lines,
      height,
      () => {
        this.refreshStatus(theme);
        tui.requestRender();
      },
      done,
    );

    const border = () =>
      new DynamicBorder((text: string) => theme.fg('accent', text));
    this.addChild(border());
    this.addChild(new PaddedPager(this.pager));
    this.addChild(this.status);
    this.addChild(border());
    this.refreshStatus(theme);
  }

  private refreshStatus(theme: Theme): void {
    const {first, last, total, scrollable} = this.pager.position();
    const keys = scrollable
      ? '↑/↓ scroll · PgUp/PgDn page · g/G ends · Enter/Esc close'
      : 'Enter or Esc to close';
    const counter = scrollable ? `  ${first}-${last}/${total}` : '';
    this.status.setText(theme.fg('dim', keys) + theme.fg('muted', counter));
  }

  handleInput(data: string): void {
    this.pager.handleInput(data);
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

interface ParsedArgs {
  sections: Set<Section>;
  unknown: string[];
}

function parseArgs(args: string): ParsedArgs {
  const sections = new Set<Section>();
  const unknown: string[] = [];

  for (const raw of args.trim().split(/\s+/).filter(Boolean)) {
    const token = raw.replace(/^--?/, '').toLowerCase();
    const match = SECTIONS.find(
      (section) =>
        section === token || `${section}s` === token ||
        section === `${token}s`,
    );
    if (!match) {
      unknown.push(raw);
    } else if (match === 'all') {
      for (const section of SECTIONS) {
        sections.add(section);
      }
    } else {
      sections.add(match);
    }
  }

  return {sections, unknown};
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand('context', {
    description:
      'Map current context-window usage by category, with per-file, ' +
      'per-skill, per-tool, and per-message detail. Pass `files`, `skills`, ' +
      '`tools`, `messages`, or `all` to expand a detail list',
    getArgumentCompletions: (prefix: string) => {
      const token = prefix.trim().toLowerCase();
      const items = SECTIONS.filter((section) => section.startsWith(token)).map(
        (section) => ({
          value: section,
          label: section,
          description: SECTION_DESCRIPTIONS[section],
        }),
      );
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const {sections, unknown} = parseArgs(args);
      if (unknown.length > 0) {
        const message = `Ignoring unknown section(s): ${unknown.join(', ')}`;
        if (ctx.hasUI) {
          ctx.ui.notify(message, 'warning');
        } else {
          console.error(message);
        }
      }

      let analysis: Analysis;
      try {
        analysis = analyze(pi, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) {
          ctx.ui.notify(`Failed to analyze context: ${message}`, 'error');
        } else {
          console.error(`Failed to analyze context: ${message}`);
        }
        return;
      }

      if (ctx.mode !== 'tui') {
        // Only print mode owns stdout as prose. JSON mode streams JSONL there
        // and RPC mode speaks its protocol there, so those get stderr.
        const text = buildReport(analysis, sections, null).join('\n');
        if (ctx.mode === 'print') {
          console.log(text);
        } else {
          console.error(text);
        }
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        return new ReportViewer(
          buildReport(analysis, sections, theme),
          tui,
          theme,
          () => done(undefined),
        );
      });
    },
  });
}
