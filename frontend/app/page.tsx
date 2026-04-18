"use client";

import { useState } from "react";
import FileUpload from "@/components/FileUpload";
import ChatWindow from "@/components/ChatWindow";
import type { UploadResult } from "@/lib/api";

export default function Home() {
  const [upload, setUpload] = useState<UploadResult | null>(null);

  return (
    <main className="h-screen bg-zinc-950 flex flex-col">
      {upload ? (
        <ChatWindow upload={upload} onReset={() => setUpload(null)} />
      ) : (
        <FileUpload onUploaded={setUpload} />
      )}
    </main>
  );
}
