import type OpenAI from "openai";
import type {
  AgentState,
  AnalyzeColumnResult,
  CorrelationResult,
  Dataset,
  DetectAnomaliesResult,
  LoadCsvResult,
  DescribeDataResult,
  SegmentAnalysisResult,
  Anomaly,
} from "./types.js";
import {
  loadCsvFile,
  getNumericValues,
  computeNumericStats,
  groupBy,
  correlationCoefficient,
  correlationStrength,
  round,
} from "./utils.js";

// ─── OpenAI tool definitions ───────────────────────────────────────────────

export const TOOL_DEFINITIONS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "load_csv",
      description:
        "Load a CSV file from disk. Returns schema, preview rows, and inferred column types. MUST be called first before any analysis.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or relative path to the CSV file." },
        },
        required: ["filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "describe_data",
      description:
        "Compute summary statistics, missing value counts, and column types for the loaded dataset.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_column",
      description:
        "Deep analysis of a single column: distribution, histogram for numeric, top-values for categorical, date range for dates.",
      parameters: {
        type: "object",
        properties: {
          column: { type: "string", description: "Exact column name to analyze." },
        },
        required: ["column"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "detect_anomalies",
      description:
        "Detect outliers (IQR method), spikes, sudden changes, and missing-value clusters across the dataset.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "segment_analysis",
      description:
        "Group data by a categorical column and compare numeric summaries across segments.",
      parameters: {
        type: "object",
        properties: {
          column: { type: "string", description: "Categorical column to group by." },
        },
        required: ["column"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "correlation_analysis",
      description:
        "Compute a Pearson correlation matrix for all numeric columns in the dataset.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

// ─── Tool implementations ──────────────────────────────────────────────────

export function toolLoadCsv(filePath: string, state: AgentState): LoadCsvResult {
  const dataset = loadCsvFile(filePath);
  state.dataset = dataset;

  return {
    filePath: dataset.filePath,
    rowCount: dataset.rowCount,
    columnCount: dataset.headers.length,
    headers: dataset.headers,
    schema: dataset.schema,
    previewRows: dataset.rows.slice(0, 5),
  };
}

export function toolDescribeData(state: AgentState): DescribeDataResult {
  requireDataset(state);
  const { rows, schema, rowCount, headers } = state.dataset!;

  const columns = schema.map((col) => {
    const values = rows.map((r) => r[col.name] ?? "");
    const nonEmpty = values.filter((v) => v !== "");

    const base = {
      name: col.name,
      type: col.type,
      missingCount: col.missingCount,
      missingPct: round(col.missingPct, 2),
      uniqueCount: col.uniqueCount,
    };

    if (col.type === "numeric" || col.type === "mixed") {
      const nums = getNumericValues(col.name, rows);
      return { ...base, stats: computeNumericStats(nums) };
    }

    const freq = new Map<string, number>();
    for (const v of nonEmpty) freq.set(v, (freq.get(v) ?? 0) + 1);
    const topValues = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([value, count]) => ({
        value,
        count,
        pct: round((count / rows.length) * 100, 2),
      }));

    return { ...base, topValues };
  });

  return { rowCount, columnCount: headers.length, columns };
}

export function toolAnalyzeColumn(column: string, state: AgentState): AnalyzeColumnResult {
  requireDataset(state);
  const { rows, schema } = state.dataset!;
  const col = schema.find((c) => c.name === column);
  if (!col) throw new Error(`Column "${column}" not found. Available: ${schema.map((c) => c.name).join(", ")}`);

  const values = rows.map((r) => r[column] ?? "");
  const nonEmpty = values.filter((v) => v !== "");
  const base = {
    column,
    type: col.type,
    totalRows: rows.length,
    missingCount: col.missingCount,
    missingPct: round(col.missingPct, 2),
  };

  if (col.type === "numeric" || col.type === "mixed") {
    const nums = getNumericValues(column, rows);
    const stats = computeNumericStats(nums);
    const bucketCount = Math.min(10, Math.ceil(Math.sqrt(nums.length)));
    const range = stats.max - stats.min;
    const bucketSize = range / bucketCount || 1;

    const histogram: { bucket: string; count: number }[] = Array.from(
      { length: bucketCount },
      (_, i) => ({
        bucket: `${round(stats.min + i * bucketSize, 2)}-${round(stats.min + (i + 1) * bucketSize, 2)}`,
        count: 0,
      })
    );

    for (const n of nums) {
      const idx = Math.min(Math.floor((n - stats.min) / bucketSize), bucketCount - 1);
      histogram[idx].count++;
    }

    return { ...base, analysis: { kind: "numeric", stats, histogram } };
  }

  if (col.type === "date") {
    const parsed = nonEmpty.map((v) => Date.parse(v)).filter((d) => !isNaN(d));
    const earliest = parsed.length ? new Date(Math.min(...parsed)).toISOString().split("T")[0] : "N/A";
    const latest = parsed.length ? new Date(Math.max(...parsed)).toISOString().split("T")[0] : "N/A";
    return { ...base, analysis: { kind: "date", earliest, latest, uniqueCount: col.uniqueCount } };
  }

  // categorical
  const freq = new Map<string, number>();
  for (const v of nonEmpty) freq.set(v, (freq.get(v) ?? 0) + 1);
  const topValues = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([value, count]) => ({ value, count, pct: round((count / rows.length) * 100, 2) }));

  return {
    ...base,
    analysis: { kind: "categorical", topValues, uniqueCount: col.uniqueCount },
  };
}

export function toolDetectAnomalies(state: AgentState): DetectAnomaliesResult {
  requireDataset(state);
  const { rows, schema } = state.dataset!;
  const anomalies: Anomaly[] = [];

  for (const col of schema) {
    // Missing-value cluster detection
    if (col.missingPct > 30) {
      anomalies.push({
        column: col.name,
        type: "missing_cluster",
        description: `${round(col.missingPct, 1)}% of values are missing in column "${col.name}".`,
        severity: col.missingPct > 60 ? "high" : "medium",
      });
    }

    if (col.type === "numeric" || col.type === "mixed") {
      const nums = getNumericValues(col.name, rows);
      if (nums.length < 4) continue;

      const stats = computeNumericStats(nums);
      const iqr = stats.p75 - stats.p25;
      const lowerFence = stats.p25 - 1.5 * iqr;
      const upperFence = stats.p75 + 1.5 * iqr;

      const outlierRows: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        const v = parseFloat(rows[i][col.name]);
        if (!isNaN(v) && (v < lowerFence || v > upperFence)) outlierRows.push(i + 2);
      }

      if (outlierRows.length > 0) {
        const severity = outlierRows.length > nums.length * 0.1 ? "high" : outlierRows.length > 3 ? "medium" : "low";
        anomalies.push({
          column: col.name,
          type: "outlier",
          description: `${outlierRows.length} outlier(s) detected in "${col.name}" outside IQR fence [${round(lowerFence, 2)}, ${round(upperFence, 2)}]. Max value: ${stats.max}, Min: ${stats.min}.`,
          severity,
          affectedRows: outlierRows.slice(0, 20),
        });
      }

      // Spike detection: if max > mean + 4*stdDev
      if (stats.stdDev > 0 && stats.max > stats.mean + 4 * stats.stdDev) {
        anomalies.push({
          column: col.name,
          type: "spike",
          description: `Spike detected in "${col.name}": max value ${stats.max} is more than 4 standard deviations above the mean (${round(stats.mean, 2)}).`,
          severity: "high",
          value: stats.max,
        });
      }

      // Sudden change detection (sequential data): check consecutive differences
      const diffs = nums.slice(1).map((v, i) => Math.abs(v - nums[i]));
      if (diffs.length > 5) {
        const diffStats = computeNumericStats(diffs);
        const suddenChanges = diffs
          .map((d, i) => ({ d, i }))
          .filter(({ d }) => diffStats.stdDev > 0 && d > diffStats.mean + 3 * diffStats.stdDev);
        if (suddenChanges.length > 0) {
          anomalies.push({
            column: col.name,
            type: "sudden_change",
            description: `${suddenChanges.length} sudden sequential change(s) detected in "${col.name}" (>3σ from mean diff of ${round(diffStats.mean, 2)}).`,
            severity: "medium",
            affectedRows: suddenChanges.map((c) => c.i + 2).slice(0, 10),
          });
        }
      }
    }

    if (col.type === "categorical") {
      const freq = new Map<string, number>();
      for (const row of rows) {
        const v = row[col.name] ?? "";
        if (v !== "") freq.set(v, (freq.get(v) ?? 0) + 1);
      }
      const total = rows.length;
      for (const [val, cnt] of freq) {
        if (cnt === 1) continue;
        const pct = (cnt / total) * 100;
        // Detect dominant category (>80%)
        if (pct > 80 && freq.size > 1) {
          anomalies.push({
            column: col.name,
            type: "freq_anomaly",
            description: `Category "${val}" in "${col.name}" dominates at ${round(pct, 1)}% of all rows, which may indicate data imbalance.`,
            severity: "low",
            value: val,
          });
        }
      }
    }
  }

  return { anomalyCount: anomalies.length, anomalies };
}

export function toolSegmentAnalysis(column: string, state: AgentState): SegmentAnalysisResult {
  requireDataset(state);
  const { rows, schema } = state.dataset!;

  const col = schema.find((c) => c.name === column);
  if (!col) throw new Error(`Column "${column}" not found.`);
  if (col.type !== "categorical" && col.type !== "boolean") {
    throw new Error(`Column "${column}" is not categorical. Use a categorical column for segmentation.`);
  }

  const numericCols = schema.filter((c) => c.type === "numeric" || c.type === "mixed").map((c) => c.name);
  const groups = groupBy(rows, column);
  const total = rows.length;

  const segments = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 20)
    .map(([segmentValue, segRows]) => ({
      segmentValue,
      rowCount: segRows.length,
      pct: round((segRows.length / total) * 100, 2),
      numericSummaries: numericCols.map((nc) => {
        const nums = getNumericValues(nc, segRows);
        const s = computeNumericStats(nums);
        return { column: nc, mean: s.mean, min: s.min, max: s.max, stdDev: s.stdDev };
      }),
    }));

  return { groupByColumn: column, segments };
}

export function toolCorrelationAnalysis(state: AgentState): CorrelationResult {
  requireDataset(state);
  const { rows, schema } = state.dataset!;

  const numericCols = schema
    .filter((c) => c.type === "numeric" || c.type === "mixed")
    .map((c) => c.name);

  const matrix: CorrelationResult["matrix"] = [];

  for (let i = 0; i < numericCols.length; i++) {
    for (let j = i + 1; j < numericCols.length; j++) {
      const col1 = numericCols[i];
      const col2 = numericCols[j];
      const xs = getNumericValues(col1, rows);
      const ys = getNumericValues(col2, rows);
      const r = correlationCoefficient(xs, ys);
      matrix.push({ col1, col2, correlation: r, strength: correlationStrength(r) });
    }
  }

  matrix.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  return { numericColumns: numericCols, matrix };
}

// ─── Tool dispatcher ───────────────────────────────────────────────────────

export function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  state: AgentState
): unknown {
  switch (name) {
    case "load_csv":
      return toolLoadCsv(args["filePath"] as string, state);
    case "describe_data":
      return toolDescribeData(state);
    case "analyze_column":
      return toolAnalyzeColumn(args["column"] as string, state);
    case "detect_anomalies":
      return toolDetectAnomalies(state);
    case "segment_analysis":
      return toolSegmentAnalysis(args["column"] as string, state);
    case "correlation_analysis":
      return toolCorrelationAnalysis(state);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function requireDataset(state: AgentState): void {
  if (!state.dataset) {
    throw new Error("No dataset loaded. Call load_csv first.");
  }
}
