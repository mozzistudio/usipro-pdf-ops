import type Anthropic from '@anthropic-ai/sdk';

// Centralized Claude model ID. Update here to switch models across the solution.
// Anthropic does not provide a "latest" alias — revisit this when new versions ship.
// Last verified: 2026-09-17 (https://platform.claude.com/docs/en/about-claude/models/overview)
export const CLAUDE_MODEL = 'claude-opus-5';

/**
 * Adaptive thinking is on by default on Opus 5 — the model decides when and how
 * deeply to reason. Depth (and token spend) is steered per call site via
 * `output_config.effort` rather than a fixed token budget.
 */
export const THINKING = { type: 'adaptive' } as const;

/**
 * Extracts the JSON payload from a Claude response.
 *
 * With thinking enabled the first content block is a `thinking` block, so the
 * text block must be located by type — indexing `content[0]` blindly yields
 * `undefined.text` and throws. Markdown fences are stripped defensively: the
 * prompts ask for bare JSON but the model may still wrap it.
 */
export function parseJsonResponse<T>(msg: Anthropic.Message): T {
  const block = msg.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!block) {
    throw new Error(`Claude returned no text block (stop_reason=${msg.stop_reason})`);
  }

  const raw = block.text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Claude returned invalid JSON: ${raw.slice(0, 200)}`);
  }
}
