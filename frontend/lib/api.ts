const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export interface UploadResult {
  sessionId: string;
  fileName: string;
  rowCount: number;
  columnCount: number;
  headers: string[];
  warnings: string[];
}

export interface SSEEvent {
  type: "tool_start" | "tool_end" | "answer" | "guardrail" | "error" | "done";
  tool?: string;
  args?: Record<string, unknown>;
  summary?: string;
  text?: string;
  message?: string;
  severity?: "warn" | "block";
  blocked?: boolean;
}

export async function uploadCsv(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file);

  const res = await fetch(`${API}/api/upload`, { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Upload failed.");
  return data as UploadResult;
}

export async function analyzeStream(
  sessionId: string,
  query: string,
  onEvent: (event: SSEEvent) => void
): Promise<void> {
  const res = await fetch(`${API}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, query }),
  });

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? "Analysis failed.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6)) as SSEEvent;
        onEvent(event);
      } catch { /* malformed line */ }
    }
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetch(`${API}/api/session/${sessionId}`, { method: "DELETE" }).catch(() => {});
}
