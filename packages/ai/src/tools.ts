import { isAppError } from '@vca/shared';
import { z } from 'zod';
import type { ToolSpec } from './types';

/**
 * - read:    no side effects (lookups, analytics)
 * - write:   low-risk, non-financial writes (e.g. create a customer, draft an order)
 * - propose: creates a PENDING confirmation for a sensitive action. It never executes it.
 *
 * There is deliberately no "execute payment" kind: money only moves after the merchant
 * confirms, through the confirmation executor — never as a direct result of a model call.
 */
export type ToolKind = 'read' | 'write' | 'propose';

export interface ToolDefinition<C, S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  kind: ToolKind;
  input: S;
  execute(input: z.infer<S>, context: C): Promise<unknown>;
}

export const defineTool = <C, S extends z.ZodType>(
  tool: ToolDefinition<C, S>,
): ToolDefinition<C, S> => tool;

export type ToolResult =
  { ok: true; data: unknown } | { ok: false; error: string; code: string; details?: unknown };

export class ToolRegistry<C> {
  private readonly tools = new Map<string, ToolDefinition<C>>();

  register<S extends z.ZodType>(tool: ToolDefinition<C, S>): this {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name))
      throw new Error(`Invalid tool name '${tool.name}'`);
    if (this.tools.has(tool.name)) throw new Error(`Tool '${tool.name}' is already registered`);
    this.tools.set(tool.name, tool as unknown as ToolDefinition<C>);
    return this;
  }

  get(name: string): ToolDefinition<C> | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** JSON-schema tool specs for the model. */
  specs(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => {
      const { $schema: _ignored, ...parameters } = z.toJSONSchema(tool.input, {
        io: 'input',
      }) as Record<string, unknown>;
      return { name: tool.name, description: tool.description, parameters };
    });
  }

  /**
   * Validates model-produced arguments and runs the tool. Expected failures (validation,
   * not found, policy) are returned to the model so it can ask the user for clarification.
   * Unexpected errors are re-thrown — they are bugs, not conversation.
   */
  async execute(name: string, rawArguments: string, context: C): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, code: 'UNKNOWN_TOOL', error: `Unknown tool '${name}'` };

    let args: unknown;
    try {
      args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
    } catch {
      return { ok: false, code: 'INVALID_ARGUMENTS', error: 'Arguments were not valid JSON' };
    }

    const parsed = tool.input.safeParse(args);
    if (!parsed.success) {
      return {
        ok: false,
        code: 'INVALID_ARGUMENTS',
        error: 'Arguments failed validation',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    }

    try {
      return { ok: true, data: await tool.execute(parsed.data, context) };
    } catch (error) {
      if (isAppError(error) && error.httpStatus < 500) {
        return { ok: false, code: error.code, error: error.message, details: error.details };
      }
      throw error;
    }
  }
}
