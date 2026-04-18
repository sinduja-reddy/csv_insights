"use client";

import { useCallback, useState } from "react";
import { UploadCloud, FileText, AlertCircle } from "lucide-react";
import { uploadCsv, type UploadResult } from "@/lib/api";

interface Props {
  onUploaded: (result: UploadResult) => void;
}

export default function FileUpload({ onUploaded }: Props) {
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Only CSV files are accepted.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const result = await uploadCsv(file);
      onUploaded(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setLoading(false);
    }
  }, [onUploaded]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-white mb-1">AI Operations Analyst</h1>
        <p className="text-zinc-400 text-sm">Upload a CSV file to begin analysis</p>
      </div>

      <label
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`w-full max-w-md border-2 border-dashed rounded-xl p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors
          ${dragging ? "border-blue-500 bg-blue-500/10" : "border-zinc-700 hover:border-zinc-500 bg-zinc-900"}`}
      >
        <input type="file" accept=".csv" className="hidden" onChange={onInputChange} />
        {loading ? (
          <div className="flex flex-col items-center gap-2">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-zinc-400 text-sm">Uploading and validating...</span>
          </div>
        ) : (
          <>
            <UploadCloud className="w-10 h-10 text-zinc-500" />
            <div className="text-center">
              <p className="text-zinc-300 text-sm font-medium">Drop your CSV here</p>
              <p className="text-zinc-500 text-xs mt-1">or click to browse · max 50 MB</p>
            </div>
          </>
        )}
      </label>

      {error && (
        <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2 w-full max-w-md">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex items-center gap-2 text-zinc-600 text-xs">
        <FileText className="w-3 h-3" />
        Supports any structured CSV · up to 500k rows
      </div>
    </div>
  );
}
