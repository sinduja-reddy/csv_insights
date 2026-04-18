"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ToolCallBadge from "./ToolCallBadge";

export interface ToolCall {
  tool: string;
  args?: Record<string, unknown>;
  status: "running" | "done";
  summary?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
}

interface Props {
  message: Message;
}

export default function MessageBubble({ message }: Props) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-xl text-sm">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 max-w-3xl">
      {/* Tool call badges */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="flex flex-col gap-1.5 mb-1">
          {message.toolCalls.map((tc, i) => (
            <ToolCallBadge
              key={i}
              tool={tc.tool}
              status={tc.status}
              summary={tc.summary}
              args={tc.args}
            />
          ))}
        </div>
      )}

      {/* Answer */}
      {message.content && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl rounded-tl-sm px-5 py-4 text-sm text-zinc-200">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h3: ({ children }) => (
                <h3 className="text-white font-semibold text-base mt-4 mb-1.5 first:mt-0">{children}</h3>
              ),
              h4: ({ children }) => (
                <h4 className="text-zinc-300 font-medium mt-3 mb-1">{children}</h4>
              ),
              p: ({ children }) => <p className="text-zinc-300 mb-2 leading-relaxed">{children}</p>,
              ul: ({ children }) => <ul className="list-disc list-inside space-y-1 mb-2 text-zinc-300">{children}</ul>,
              ol: ({ children }) => <ol className="list-decimal list-inside space-y-1 mb-2 text-zinc-300">{children}</ol>,
              li: ({ children }) => <li className="text-zinc-300">{children}</li>,
              strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
              code: ({ children }) => (
                <code className="bg-zinc-800 text-blue-300 px-1.5 py-0.5 rounded text-xs font-mono">{children}</code>
              ),
              table: ({ children }) => (
                <div className="overflow-x-auto my-3">
                  <table className="text-xs border-collapse w-full">{children}</table>
                </div>
              ),
              th: ({ children }) => (
                <th className="border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-left text-zinc-300 font-medium">{children}</th>
              ),
              td: ({ children }) => (
                <td className="border border-zinc-700 px-3 py-1.5 text-zinc-400">{children}</td>
              ),
              blockquote: ({ children }) => (
                <blockquote className="border-l-2 border-blue-500 pl-3 italic text-zinc-400 my-2">{children}</blockquote>
              ),
            }}
          >
            {message.content}
          </ReactMarkdown>
          {message.isStreaming && (
            <span className="inline-block w-2 h-4 bg-blue-400 animate-pulse rounded-sm ml-0.5 align-middle" />
          )}
        </div>
      )}

      {/* Still running but no content yet */}
      {!message.content && message.isStreaming && (
        <div className="flex items-center gap-2 text-zinc-500 text-sm px-1">
          <div className="flex gap-1">
            <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce [animation-delay:300ms]" />
          </div>
          Analyzing...
        </div>
      )}
    </div>
  );
}
