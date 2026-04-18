
import * as fs from "fs";
import type { ToolCallResult } from "./types.js";

// ─── Constants ─────────────────────────────────────────────────────────────

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_ROWS = 500_000;
const MAX_COLUMNS = 200;
const MIN_TOOL_CALLS = 2;

const REQUIRED_OUTPUT_SECTIONS = [
  "Key Findings",
  "Anomalies",
  "Root Cause Hypotheses",
  "Business Impact",
  "Recommended Actions",
  "Follow-up Question",
];

const BANNED_PHRASES = [
  "optimize efficiency",
  "improve performance",
  "leverage insights",
  "drive value",
  "actionable insights",
  "best practices",
  "enhance productivity",
  "streamline operations",
  "maximize output",
];

// Patterns that look like prompt injection attempts
const INJECTION_PATTERNS = [
  /ignore (previous|all|above|prior) instructions?/i,
  /you are now/i,
  /pretend (you are|to be)/i,
  /disregard (your|the) (system|previous)/i,
  /new (role|persona|instruction)/i,
  /\[system\]/i,
  /\[user\]/i,
  /\[assistant\]/i,
  /act as (a|an) (?!analyst|data)/i,
  /jailbreak/i,
  /DAN mode/i,
  /override (your|the) (system|instructions)/i,
];

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GuardrailViolation {
  rule: string;
  message: string;
  severity: "warn" | "block";
}

export interface GuardrailResult {
  passed: boolean;
  violations: GuardrailViolation[];
}

// ─── Input guardrails ───────────────────────────────────────────────────────

export function validateFileInput(filePath: string): GuardrailResult {
  const violations: GuardrailViolation[] = [];

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return {
      passed: false,
      violations: [{ rule: "file_exists", message: `File not found: ${filePath}`, severity: "block" }],
    };
  }

  if (stat.size > MAX_FILE_SIZE_BYTES) {
    violations.push({
      rule: "file_size",
      message: `File size ${(stat.size / 1024 / 1024).toFixed(1)} MB exceeds the 50 MB limit.`,
      severity: "block",
    });
  }

  if (stat.size === 0) {
    violations.push({ rule: "file_empty", message: "File is empty.", severity: "block" });
  }

  return { passed: violations.every((v) => v.severity !== "block"), violations };
}

export function validateRowAndColumnLimits(
  rowCount: number,
  columnCount: number
): GuardrailResult {
  const violations: GuardrailViolation[] = [];

  if (rowCount > MAX_ROWS) {
    violations.push({
      rule: "row_limit",
      message: `Dataset has ${rowCount.toLocaleString()} rows. Maximum allowed is ${MAX_ROWS.toLocaleString()}.`,
      severity: "block",
    });
  }

  if (columnCount > MAX_COLUMNS) {
    violations.push({
      rule: "column_limit",
      message: `Dataset has ${columnCount} columns. Maximum allowed is ${MAX_COLUMNS}.`,
      severity: "warn",
    });
  }

  return { passed: violations.every((v) => v.severity !== "block"), violations };
}

export function detectPromptInjection(text: string, source: "user_query" | "csv_data"): GuardrailResult {
  const violations: GuardrailViolation[] = [];

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      violations.push({
        rule: "prompt_injection",
        message: `Potential prompt injection detected in ${source}: matched pattern "${pattern.source}".`,
        severity: "block",
      });
      break; // one match is enough to block
    }
  }

  return { passed: violations.length === 0, violations };
}

export function scanCsvForInjection(rows: Record<string, string>[]): GuardrailResult {
  const violations: GuardrailViolation[] = [];
  const sampleSize = Math.min(rows.length, 1000);

  for (let i = 0; i < sampleSize; i++) {
    const row = rows[i];
    for (const [col, val] of Object.entries(row)) {
      if (typeof val === "string" && val.length > 20) {
        const result = detectPromptInjection(val, "csv_data");
        if (!result.passed) {
          violations.push({
            rule: "csv_injection",
            message: `Suspicious content in column "${col}", row ${i + 2}: value appears to contain injection attempt.`,
            severity: "warn",
          });
          break;
        }
      }
    }
    if (violations.length > 0) break;
  }

  return { passed: true, violations }; // warn only, don't block
}

// ─── Agent output guardrails ────────────────────────────────────────────────

export function enforceMinToolCalls(
  toolHistory: ToolCallResult[],
  currentCallToolCount?: number
): GuardrailResult {
  const violations: GuardrailViolation[] = [];

  const hasLoadCsvInHistory = toolHistory.some((t) => t.tool === "load_csv");
  const isFollowUp = hasLoadCsvInHistory && toolHistory.length > MIN_TOOL_CALLS;

  // Follow-up questions only need 1 analysis tool call; initial analysis needs MIN_TOOL_CALLS
  const required = isFollowUp ? 1 : MIN_TOOL_CALLS;
  const count = currentCallToolCount ?? toolHistory.length;

  if (count < required) {
    violations.push({
      rule: "min_tool_calls",
      message: `Only ${count} tool call(s) were made. Minimum required: ${required}. The agent must use tools to ground every claim.`,
      severity: "block",
    });
  }

  if (!hasLoadCsvInHistory && toolHistory.length > 0) {
    violations.push({
      rule: "load_csv_required",
      message: "load_csv was never called. Dataset must be loaded before analysis.",
      severity: "block",
    });
  }

  return { passed: violations.every((v) => v.severity !== "block"), violations };
}

export function validateOutputFormat(response: string): GuardrailResult {
  const violations: GuardrailViolation[] = [];

  for (const section of REQUIRED_OUTPUT_SECTIONS) {
    if (!response.includes(section)) {
      violations.push({
        rule: "missing_section",
        message: `Required output section missing: "${section}".`,
        severity: "warn",
      });
    }
  }

  return { passed: violations.every((v) => v.severity !== "block"), violations };
}

export function detectBannedPhrases(response: string): GuardrailResult {
  const violations: GuardrailViolation[] = [];
  const lower = response.toLowerCase();

  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      violations.push({
        rule: "banned_phrase",
        message: `Generic/vague phrase detected: "${phrase}". Recommendations must be specific and data-driven.`,
        severity: "warn",
      });
    }
  }

  return { passed: true, violations }; // warn only
}

// ─── Composite check ────────────────────────────────────────────────────────

export function runOutputGuardrails(
  response: string,
  toolHistory: ToolCallResult[],
  currentCallToolCount?: number
): GuardrailResult {
  const results = [
    enforceMinToolCalls(toolHistory, currentCallToolCount),
    validateOutputFormat(response),
    detectBannedPhrases(response),
  ];

  const allViolations = results.flatMap((r) => r.violations);
  const passed = results.every((r) => r.passed);

  return { passed, violations: allViolations };
}
