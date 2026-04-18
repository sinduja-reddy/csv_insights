import OpenAI from "openai";
import type { AgentState, ToolCallResult } from "./types.js";
import { TOOL_DEFINITIONS, dispatchTool } from "./tools.js";
import {
  detectPromptInjection,
  runOutputGuardrails,
  type GuardrailViolation,
} from "./guardrails.js";

export interface AgentEvent {
  type: "tool_start" | "tool_end" | "answer" | "guardrail" | "error";
  tool?: string;
  args?: Record<string, unknown>;
  summary?: string;
  text?: string;
  message?: string;
  severity?: "warn" | "block";
}

export interface RunOptions {
  verbose?: boolean;
  maxIterations?: number;
  onGuardrailViolation?: (violations: GuardrailViolation[]) => void;
  onEvent?: (event: AgentEvent) => void;
}

const SYSTEM_PROMPT = `You are an AI Operations Analyst — a structured data analyst embedded in an industrial operations team.

## Your Mission
Analyze CSV datasets rigorously and produce evidence-based, actionable insights. You behave like a senior operations analyst: methodical, evidence-driven, and direct.

## Mandatory Analysis Flow
You MUST follow this sequence for every analysis:
1. Call load_csv to load the dataset
2. Call describe_data to understand structure and quality
3. Call at least one deep analysis tool (analyze_column, correlation_analysis, or segment_analysis)
4. Call detect_anomalies to surface problems
5. Synthesize findings into a structured report

Never skip steps. Never give conclusions without tool evidence.

## Tool Usage Rules
- Call tools BEFORE making any claims about the data
- Minimum 2 tool calls before any final response
- Every claim must cite the tool that produced the evidence
- If uncertain about a column's meaning, call analyze_column before using it

## Evidence Requirement
Every finding must include:
- The specific metric/value observed
- The column name(s) involved
- The tool that produced the evidence
Example: "Error rate spiked to 142 on 2024-03-15 (detect_anomalies on error_count column)"

## BANNED behaviors
- Inventing numbers, trends, or observations not from tool outputs
- Generic advice like "optimize efficiency" or "improve performance"
- Skipping analysis steps
- Assuming column meaning without checking

## Output Format (STRICT — always use this exact structure)
Your final response MUST contain these exact sections:

### 1. Key Findings
- Bullet list of factual observations with supporting evidence

### 2. Anomalies Detected
- List each anomaly: type, column, severity, description

### 3. Root Cause Hypotheses ⚠️ (Hypotheses Only)
- Clearly labeled as hypotheses
- Tied to specific data patterns observed

### 4. Business Impact
- Quantified where possible
- Tied to specific columns/metrics

### 5. Recommended Actions
At least 2 actions, each specifying:
- What to do
- Where (column/process/system)
- Expected impact

### 6. Follow-up Question
One targeted question to help deepen the analysis.

## Actionability Rules
Every recommendation must be:
- Specific (not vague)
- Tied to a dataset column or metric
- Include an expected impact

## Uncertainty Handling
- If a question cannot be answered from the data → say so explicitly
- If a column's meaning is ambiguous → call analyze_column then ask the user
- Never guess`;

export async function runAgent(
  openai: OpenAI,
  userMessage: string,
  state: AgentState,
  options: RunOptions = {}
): Promise<string> {
  const { verbose = false, maxIterations = 20, onGuardrailViolation, onEvent } = options;

  const emit = (event: AgentEvent) => onEvent?.(event);

  const injectionCheck = detectPromptInjection(userMessage, "user_query");
  if (!injectionCheck.passed) {
    emit({ type: "error", message: injectionCheck.violations[0]?.message });
    throw new GuardrailError("Input blocked by guardrail.", injectionCheck.violations);
  }

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];

  let iterations = 0;
  let currentCallToolCount = 0;

  while (iterations < maxIterations) {
    iterations++;

    if (verbose) console.error(`\n[Agent] Iteration ${iterations}`);

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: "auto",
      temperature: 0.2,
    });

    const choice = response.choices[0];
    if (!choice) throw new Error("No response from OpenAI.");

    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      if (!assistantMessage.content) throw new Error("Empty response with no tool calls.");

      const outputCheck = runOutputGuardrails(assistantMessage.content, state.toolHistory, currentCallToolCount);
      if (outputCheck.violations.length > 0) {
        onGuardrailViolation?.(outputCheck.violations);
        for (const v of outputCheck.violations) {
          emit({ type: "guardrail", message: v.message, severity: v.severity });
        }
      }
      if (!outputCheck.passed) {
        throw new GuardrailError("Output blocked by guardrail.", outputCheck.violations);
      }

      emit({ type: "answer", text: assistantMessage.content });
      return assistantMessage.content;
    }

    const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== "function") continue;
      const fn = (toolCall as OpenAI.Chat.ChatCompletionMessageToolCall & { type: "function" }).function;
      const toolName = fn.name;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(fn.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }

      emit({ type: "tool_start", tool: toolName, args });
      if (verbose) console.error(`[Tool] ${toolName}(${JSON.stringify(args)})`);
      currentCallToolCount++;

      let resultContent: string;
      let summary: string;
      try {
        const result = dispatchTool(toolName, args, state);
        const entry: ToolCallResult = { tool: toolName, result };
        state.toolHistory.push(entry);
        resultContent = JSON.stringify(result, null, 2);
        summary = buildToolSummary(toolName, result);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        resultContent = JSON.stringify({ error: errMsg });
        summary = `Error: ${errMsg}`;
        if (verbose) console.error(`[Tool Error] ${toolName}: ${errMsg}`);
      }

      emit({ type: "tool_end", tool: toolName, summary });

      toolResults.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: resultContent,
      });
    }

    messages.push(...toolResults);
  }

  throw new Error(`Agent exceeded maximum iterations (${maxIterations}).`);
}

function buildToolSummary(toolName: string, result: unknown): string {
  const r = result as Record<string, unknown>;
  switch (toolName) {
    case "load_csv":
      return `Loaded ${r["rowCount"]} rows, ${r["columnCount"]} columns`;
    case "describe_data":
      return `Described ${(r["columns"] as unknown[])?.length ?? 0} columns`;
    case "analyze_column":
      return `Analyzed column "${r["column"]}" (${r["type"]})`;
    case "detect_anomalies":
      return `Found ${r["anomalyCount"]} anomalies`;
    case "segment_analysis":
      return `Segmented by "${r["groupByColumn"]}" into ${(r["segments"] as unknown[])?.length ?? 0} groups`;
    case "correlation_analysis":
      return `Computed ${(r["matrix"] as unknown[])?.length ?? 0} correlation pairs`;
    default:
      return "Done";
  }
}

export function createAgentState(): AgentState {
  return { dataset: null, toolHistory: [] };
}

export class GuardrailError extends Error {
  constructor(
    message: string,
    public readonly violations: GuardrailViolation[]
  ) {
    super(message);
    this.name = "GuardrailError";
  }
}
