"use client";
import dynamic from "next/dynamic";

// PDF.js, pdf-lib and fontkit are browser-only here: load the editor on the client.
const Editor = dynamic(() => import("./Editor"), {
  ssr: false,
  loading: () => <div className="grid h-screen place-items-center text-sm text-muted">Loading editor…</div>,
});

export default function EditorLoader() {
  return <Editor />;
}
