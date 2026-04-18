"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, FileText, X, AlertTriangle } from "lucide-react";
import MessageBubble, { type Message, type ToolCall } from "./MessageBubble";
import { analyzeStream, deleteSession, type SSEEvent, type UploadResult } from "@/lib/api";

interface Props {
  upload: UploadResult;
  onReset: () => void;
}

const INITIAL_QUERY =
  "Perform a full structured analysis: load the dataset, describe its structure, run deep analysis on key columns, detect anomalies, and produce the complete structured report.";

export default function ChatWindow({ upload, onReset }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[]>(upload.warnings);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const didAutoRun = useRef(false);

  const scrollToBottom = () =>
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });

  useEffect(() => { scrollToBottom(); }, [messages]);

  const runQuery = useCallback(async (query: string) => {
    if (busy || !query.trim()) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: query.trim(),
    };

    const assistantId = crypto.randomUUID();
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      toolCalls: [],
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setBusy(true);

    try {
      await analyzeStream(upload.sessionId, query, (event: SSEEvent) => {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m;

            switch (event.type) {
              case "tool_start": {
                const tc: ToolCall = {
                  tool: event.tool!,
                  args: event.args,
                  status: "running",
                };
                return { ...m, toolCalls: [...(m.toolCalls ?? []), tc] };
              }
              case "tool_end": {
                const updated = (m.toolCalls ?? []).map((tc) =>
                  tc.tool === event.tool && tc.status === "running"
                    ? { ...tc, status: "done" as const, summary: event.summary }
                    : tc
                );
                return { ...m, toolCalls: updated };
              }
              case "answer":
                return { ...m, content: event.text ?? "", isStreaming: false };
              case "guardrail":
                if (event.severity === "warn") {
                  setWarnings((w) => [...w, event.message ?? ""]);
                }
                return m;
              case "error":
                return {
                  ...m,
                  content: `**Error:** ${event.message}`,
                  isStreaming: false,
                };
              default:
                return m;
            }
          })
        );
      });
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `**Error:** ${err instanceof Error ? err.message : "Unknown error"}`, isStreaming: false }
            : m
        )
      );
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [busy, upload.sessionId]);

  // Auto-run initial analysis once
  useEffect(() => {
    if (!didAutoRun.current) {
      didAutoRun.current = true;
      runQuery(INITIAL_QUERY);
    }
  }, [runQuery]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    const q = input.trim();
    setInput("");
    runQuery(q);
  };

  const handleReset = () => {
    deleteSession(upload.sessionId);
    onReset();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-2.5">
          <FileText className="w-4 h-4 text-blue-400" />
          <div>
            <p className="text-sm font-medium text-white">{upload.fileName}</p>
            <p className="text-xs text-zinc-500">
              {upload.rowCount.toLocaleString()} rows · {upload.columnCount} columns
            </p>
          </div>
        </div>
        <button
          onClick={handleReset}
          className="text-zinc-500 hover:text-zinc-300 transition-colors p-1 rounded"
          title="Load new file"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="px-5 py-2 bg-yellow-500/10 border-b border-yellow-500/20 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-yellow-400 mt-0.5 shrink-0" />
          <div className="text-xs text-yellow-400 space-y-0.5">
            {warnings.map((w, i) => <p key={i}>{w}</p>)}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-5 py-4 border-t border-zinc-800">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            placeholder={busy ? "Analyzing…" : "Ask a follow-up question…"}
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500 disabled:opacity-50 transition-colors"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-xl px-4 py-2.5 transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
        <p className="text-xs text-zinc-600 mt-1.5 pl-1">
          All analysis is grounded in tool calls — no hallucinated data
        </p>
      </div>
    </div>
  );
}
