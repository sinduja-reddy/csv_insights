export type ColumnType = "numeric" | "categorical" | "date" | "boolean" | "mixed" | "unknown";

export interface ColumnSchema {
  name: string;
  type: ColumnType;
  sampleValues: string[];
  uniqueCount: number;
  missingCount: number;
  missingPct: number;
}

export interface Dataset {
  filePath: string;
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
  schema: ColumnSchema[];
}

export interface LoadCsvResult {
  filePath: string;
  rowCount: number;
  columnCount: number;
  headers: string[];
  schema: ColumnSchema[];
  previewRows: Record<string, string>[];
}

export interface DescribeDataResult {
  rowCount: number;
  columnCount: number;
  columns: {
    name: string;
    type: ColumnType;
    missingCount: number;
    missingPct: number;
    uniqueCount: number;
    stats?: NumericStats;
    topValues?: { value: string; count: number; pct: number }[];
  }[];
}

export interface NumericStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  stdDev: number;
  p25: number;
  p75: number;
}

export interface AnalyzeColumnResult {
  column: string;
  type: ColumnType;
  totalRows: number;
  missingCount: number;
  missingPct: number;
  analysis:
    | { kind: "numeric"; stats: NumericStats; histogram: { bucket: string; count: number }[] }
    | { kind: "categorical"; topValues: { value: string; count: number; pct: number }[]; uniqueCount: number }
    | { kind: "date"; earliest: string; latest: string; uniqueCount: number }
    | { kind: "unknown" };
}

export interface Anomaly {
  column: string;
  type: "outlier" | "spike" | "missing_cluster" | "sudden_change" | "freq_anomaly";
  description: string;
  severity: "low" | "medium" | "high";
  affectedRows?: number[];
  value?: string | number;
}

export interface DetectAnomaliesResult {
  anomalyCount: number;
  anomalies: Anomaly[];
}

export interface SegmentAnalysisResult {
  groupByColumn: string;
  segments: {
    segmentValue: string;
    rowCount: number;
    pct: number;
    numericSummaries: {
      column: string;
      mean: number;
      min: number;
      max: number;
      stdDev: number;
    }[];
  }[];
}

export interface CorrelationResult {
  numericColumns: string[];
  matrix: { col1: string; col2: string; correlation: number; strength: string }[];
}

export interface ToolCallResult {
  tool: string;
  result: unknown;
}

export interface AgentState {
  dataset: Dataset | null;
  toolHistory: ToolCallResult[];
}
