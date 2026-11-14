/**
 * dsh-runtime-reconcile — Host half. Read-only, zero-dependency.
 *
 * All inspection logic lives in core.js (pure, unit-tested). This module only
 * wires one model-facing tool to it. No @deepseek-ai/* runtime imports: see
 * deepseek-harness discussion #1697 for the hoisted-shadowing hazard.
 */

import { collect, normalizeOptions, renderText } from './core.js';

export { collect, normalizeOptions, renderText } from './core.js';

function reconcileTool(ctx) {
  return {
    // Namespaced on purpose: generic names collide across the ecosystem
    // (553 tool-name collisions measured in discussion #4253).
    name: 'reconcile_runtime',
    description:
      'Read-only live inspection of the running DeepSeek Harness profile. Reconciles what is configured against what is actually registered: configured-but-missing or unavailable web providers (the cause of "configured web provider is not registered"), disabled bundles correlated as the likely root cause, enabled-but-not-active Loader rows, tool registry health, and missing core services. Reports actionable remedies. Makes no network calls and changes nothing. Use this when a tool fails mysteriously, after installing/enabling plugins, or to check profile health.',
    parameters: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          enum: ['all', 'providers', 'bundles', 'rows', 'tools', 'services'],
          description: 'Which check group to run. Default "all". Use "providers" for the fast web-provider diagnosis.',
        },
        maxTools: {
          type: 'number',
          description: 'Cap on tool names listed in the snapshot (default 40, max 200). Does not limit the checks.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          complete: { type: 'boolean' },
          focus: { type: 'string' },
          generatedAt: { type: 'string' },
          version: { type: 'string' },
          summary: {
            type: 'object',
            additionalProperties: false,
            properties: {
              errors: { type: 'number' },
              warnings: { type: 'number' },
              info: { type: 'number' },
            },
          },
          completeness: {
            type: 'object',
            additionalProperties: false,
            properties: {
              checked: { type: 'array', items: { type: 'string' } },
              unavailable: { type: 'array', items: { type: 'string' } },
            },
          },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                severity: { type: 'string' },
                code: { type: 'string' },
                title: { type: 'string' },
                detail: { type: 'string' },
                remedy: { type: 'string' },
              },
            },
          },
          snapshot: { type: 'object', additionalProperties: true },
          note: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: renderText(value) }];
      },
    },
    async execute(args = {}) {
      const options = normalizeOptions(args);
      return collect(ctx, options);
    },
  };
}

export function apply(ctx) {
  // No row-level inject: the plugin must always mount so it can *report* a
  // missing service rather than silently not activating. Register the tool only
  // when the tools seam is present.
  ctx.inject(['tools'], (scoped) => {
    let tools;
    try {
      tools = scoped.get('tools') ?? ctx.get('tools');
    } catch {
      return;
    }
    if (!tools || typeof tools.register !== 'function') return;
    const dispose = tools.register(reconcileTool(ctx));
    scoped.effect(() => dispose);
  });
}
