import * as fs from "fs";
import { parse } from "csv-parse/sync";
import type { ColumnSchema, ColumnType, Dataset, NumericStats } from "./types.js";

export function loadCsvFile(filePath: string): Dataset {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const rows: Record<string, string>[] = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (rows.length === 0) {
    throw new Error("CSV file is empty or has no data rows.");
  }

  const headers = Object.keys(rows[0]);
  const schema = headers.map((col) => inferColumnSchema(col, rows));

  return { filePath, headers, rows, rowCount: rows.length, schema };
}

export function inferColumnSchema(col: string, rows: Record<string, string>[]): ColumnSchema {
  const values = rows.map((r) => r[col] ?? "");
  const nonEmpty = values.filter((v) => v !== "" && v !== null && v !== undefined);
  const missingCount = values.length - nonEmpty.length;
  const uniqueCount = new Set(nonEmpty).size;
  const sampleValues = nonEmpty.slice(0, 5);

  let type: ColumnType = detectType(nonEmpty);

  return {
    name: col,
    type,
    sampleValues,
    uniqueCount,
    missingCount,
    missingPct: values.length > 0 ? (missingCount / values.length) * 100 : 0,
  };
}

function detectType(values: string[]): ColumnType {
  if (values.length === 0) return "unknown";

  const numericCount = values.filter((v) => !isNaN(Number(v)) && v.trim() !== "").length;
  const dateCount = values.filter((v) => isDateLike(v)).length;
  const boolCount = values.filter((v) => ["true", "false", "yes", "no", "1", "0"].includes(v.toLowerCase())).length;

  const ratio = (count: number) => count / values.length;

  if (ratio(numericCount) > 0.9) return "numeric";
  if (ratio(dateCount) > 0.9) return "date";
  if (ratio(boolCount) > 0.9) return "boolean";
  if (ratio(numericCount) > 0.4) return "mixed";
  return "categorical";
}

function isDateLike(v: string): boolean {
  if (!v || v.length < 6) return false;
  return !isNaN(Date.parse(v));
}

export function getNumericValues(col: string, rows: Record<string, string>[]): number[] {
  return rows
    .map((r) => parseFloat(r[col]))
    .filter((v) => !isNaN(v));
}

export function computeNumericStats(values: number[]): NumericStats {
  if (values.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, stdDev: 0, p25: 0, p75: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  const pct = (p: number) => {
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: round(mean, 4),
    median: round(pct(50), 4),
    stdDev: round(stdDev, 4),
    p25: round(pct(25), 4),
    p75: round(pct(75), 4),
  };
}

export function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

export function groupBy(
  rows: Record<string, string>[],
  col: string
): Map<string, Record<string, string>[]> {
  const map = new Map<string, Record<string, string>[]>();
  for (const row of rows) {
    const key = row[col] ?? "(missing)";
    const bucket = map.get(key) ?? [];
    bucket.push(row);
    map.set(key, bucket);
  }
  return map;
}

export function correlationCoefficient(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const meanX = xs.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanY = ys.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const denom = Math.sqrt(denX * denY);
  return denom === 0 ? 0 : round(num / denom, 4);
}

export function correlationStrength(r: number): string {
  const abs = Math.abs(r);
  if (abs >= 0.8) return "very strong";
  if (abs >= 0.6) return "strong";
  if (abs >= 0.4) return "moderate";
  if (abs >= 0.2) return "weak";
  return "negligible";
}
