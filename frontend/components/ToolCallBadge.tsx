"use client";

import { Loader2, CheckCircle2, Database, BarChart2, Search, GitBranch, TrendingUp, Activity } from "lucide-react";

const TOOL_META: Record<string, { label: string; icon: React.ReactNode }> = {
  load_csv:             { label: "Loading CSV",           icon: <Database className="w-3 h-3" /> },
  describe_data:        { label: "Describing data",       icon: <BarChart2 className="w-3 h-3" /> },
  analyze_column:       { label: "Analyzing column",      icon: <Search className="w-3 h-3" /> },
  detect_anomalies:     { label: "Detecting anomalies",   icon: <Activity className="w-3 h-3" /> },
  segment_analysis:     { label: "Segment analysis",      icon: <GitBranch className="w-3 h-3" /> },
  correlation_analysis: { label: "Correlation analysis",  icon: <TrendingUp className="w-3 h-3" /> },
};

interface Props {
  tool: string;
  status: "running" | "done";
  summary?: string;
  args?: Record<string, unknown>;
}

export default function ToolCallBadge({ tool, status, summary, args }: Props) {
  const meta = TOOL_META[tool] ?? { label: tool, icon: <Search className="w-3 h-3" /> };
  const detail = args?.["column"] ? ` · ${args["column"]}` : "";

  return (
    <div className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-full w-fit
      ${status === "done"
        ? "bg-zinc-800 text-zinc-400"
        : "bg-blue-500/10 text-blue-400 border border-blue-500/20"}`}
    >
      {status === "running" ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <CheckCircle2 className="w-3 h-3 text-green-500" />
      )}
      {meta.icon}
      <span>{meta.label}{detail}</span>
      {status === "done" && summary && (
        <span className="text-zinc-500 ml-1">— {summary}</span>
      )}
    </div>
  );
}
