"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  DemoUser,
  ClientDocumentMeta,
  ClientDocumentDetail,
  ConversationMessage,
} from "@/lib/types";

interface AppState {
  user: DemoUser | null;
  label: string;
  documents: ClientDocumentMeta[];
  loadingDocs: boolean;
  docError: string | null;
}

const DEMO_USERS: { id: string; display_name: string; role: string }[] = [
  { id: "daniel", display_name: "Daniel Ong", role: "Engineering" },
  { id: "priya", display_name: "Priya Menon", role: "Compliance" },
  { id: "marcus", display_name: "Marcus Teo", role: "Contractor" },
];

const PLATFORM_COLORS: Record<string, string> = {
  confluence: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  jira: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  slack:
    "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  google_drive:
    "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
};

const PLATFORM_LABELS: Record<string, string> = {
  confluence: "Confluence",
  jira: "Jira",
  slack: "Slack",
  google_drive: "Google Drive",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export default function HomePage() {
  const [state, setState] = useState<AppState>({
    user: null,
    label: "",
    documents: [],
    loadingDocs: false,
    docError: null,
  });

  const [selectedDoc, setSelectedDoc] = useState<ClientDocumentDetail | null>(
    null,
  );
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [docDetailError, setDocDetailError] = useState<string | null>(null);

  // Q&A state — conversations are isolated by user.
  // conversations[userId] = ConversationMessage[]
  const [conversations, setConversations] = useState<
    Record<string, ConversationMessage[]>
  >({});
  const [questionInput, setQuestionInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [modelConfigured, setModelConfigured] = useState<boolean | null>(null);
  const [modelProvider, setModelProvider] = useState<string | null>(null);
  const [modelModel, setModelModel] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [citationValidationError, setCitationValidationError] = useState<string | null>(null);

  const fetchSessionAndDocs = useCallback(async (userId: string | null) => {
    const headers: Record<string, string> = {};
    if (userId) headers["x-demo-user"] = userId;

    // Fetch session
    const sessionRes = await fetch("/api/session", { headers });
    const sessionData = await sessionRes.json();

    setState({
      user: sessionData.user ?? null,
      label: sessionData.label ?? "",
      documents: [],
      loadingDocs: true,
      docError: null,
    });
    setSelectedDoc(null);
    setDocDetailError(null);

    // Clear the displayed conversation when switching users.
    // Stored conversation context remains isolated by user in the
    // `conversations` record.
    setAsking(false);

    if (!sessionData.user) {
      setState((s) => ({ ...s, loadingDocs: false }));
      return;
    }

    // Fetch permitted document list
    const docsRes = await fetch("/api/documents", { headers });
    if (!docsRes.ok) {
      const err = await docsRes.json().catch(() => ({}));
      setState((s) => ({
        ...s,
        loadingDocs: false,
        docError: err.error ?? "Failed to load documents.",
      }));
      return;
    }
    const docsData = await docsRes.json();
    setState((s) => ({
      ...s,
      documents: docsData.documents ?? [],
      count: docsData.count,
      loadingDocs: false,
    }));
  }, []);

  // On mount, check if there's already a session (e.g. from localStorage)
  useEffect(() => {
    const stored = localStorage.getItem("demo-user");
    fetchSessionAndDocs(stored);
  }, [fetchSessionAndDocs]);

  const handleSelectUser = (userId: string) => {
    localStorage.setItem("demo-user", userId);
    fetchSessionAndDocs(userId);
  };

  const handleSelectDocument = async (docId: string) => {
    setLoadingDoc(true);
    setDocDetailError(null);
    setSelectedDoc(null);

    const headers: Record<string, string> = {};
    if (state.user) headers["x-demo-user"] = state.user.id;

    const res = await fetch(`/api/documents/${docId}`, { headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setDocDetailError(
        err.error ?? "Document not found or not available to you.",
      );
      setLoadingDoc(false);
      return;
    }
    const data = await res.json();
    setSelectedDoc(data);
    setLoadingDoc(false);
  };

  // Check model configuration — detected from the first /api/ask response.

  const handleAsk = async () => {
    if (!state.user || !questionInput.trim() || asking) return;

    const userId = state.user.id;
    const query = questionInput.trim();
    setQuestionInput("");
    setAsking(true);

    // Add the user's question to the conversation immediately.
    const userMessage: ConversationMessage = {
      role: "user",
      content: query,
      citations: [],
      timestamp: new Date().toISOString(),
    };

    setConversations((prev) => ({
      ...prev,
      [userId]: [...(prev[userId] ?? []), userMessage],
    }));

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-demo-user": userId,
    };

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers,
        body: JSON.stringify({ query }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const errorMessage: ConversationMessage = {
          role: "assistant",
          content: `Error: ${err.error ?? "Request failed."}`,
          citations: [],
          timestamp: new Date().toISOString(),
        };
        setConversations((prev) => ({
          ...prev,
          [userId]: [...(prev[userId] ?? []), errorMessage],
        }));
        setAsking(false);
        return;
      }

      const data = await res.json();

      // Update model config status from the response.
      if (data.model_configured !== undefined) {
        setModelConfigured(data.model_configured);
        setModelProvider(data.model_provider);
        setModelModel(data.model_model);
      }
      setModelError(data.model_error ?? null);
      setCitationValidationError(data.citation_validation_error ?? null);

      const assistantMessage: ConversationMessage = {
        role: "assistant",
        content: data.answer,
        citations: data.citations ?? [],
        timestamp: new Date().toISOString(),
        request_id: data.request_id,
      };

      setConversations((prev) => ({
        ...prev,
        [userId]: [...(prev[userId] ?? []), assistantMessage],
      }));
    } catch {
      // Network/connection failure — show a distinct error message
      // instead of disguising it as "no information found."
      const errorMessage: ConversationMessage = {
        role: "assistant",
        content: "Connection error: unable to reach the server. Please check your network and try again.",
        citations: [],
        timestamp: new Date().toISOString(),
      };
      setConversations((prev) => ({
        ...prev,
        [userId]: [...(prev[userId] ?? []), errorMessage],
      }));
    }

    setAsking(false);
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Internal Brain</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Permission-filtered document retrieval — hackathon demo
            </p>
          </div>
          {state.user && (
            <div className="text-right">
              <div className="text-sm font-medium">
                {state.user.display_name}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 capitalize">
                {state.user.role.replace(/_/g, " ")}
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        {/* Demo User Selector */}
        <section className="mb-6 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Demo User Selector
            </h2>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-100 dark:bg-yellow-900/50 px-2.5 py-1 text-xs font-medium text-yellow-800 dark:text-yellow-200">
              <svg
                className="h-3.5 w-3.5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z"
                  clipRule="evenodd"
                />
              </svg>
              {state.label || "Local demonstration only"}
            </span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            This selector chooses a demo identity for local testing. It is not
            production authentication. Roles and document permissions are
            resolved server-side and cannot be supplied by the browser.
          </p>
          <div className="flex gap-2">
            {DEMO_USERS.map((u) => (
              <button
                key={u.id}
                onClick={() => handleSelectUser(u.id)}
                className={`flex-1 rounded-lg border px-4 py-3 text-left transition ${
                  state.user?.id === u.id
                    ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/50 dark:border-indigo-500"
                    : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 bg-white dark:bg-gray-900"
                }`}
              >
                <div className="font-medium text-sm">{u.display_name}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {u.role}
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Q&A Section */}
        <section className="mb-6 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-3">
            Ask a Question
          </h2>

          {/* Model config notice */}
          {state.user && modelConfigured === false && (
            <div className="mb-3 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              <strong>Model not configured.</strong> No language model API key
              found. The app returns the neutral fallback response. Create{" "}
              <code className="font-mono">.env.local</code> with{" "}
              <code className="font-mono">ADP_APP_KEY</code> (preferred),
              or one of{" "}
              <code className="font-mono">CODEBUDDY_API_KEY</code>,{" "}
              <code className="font-mono">OPENAI_API_KEY</code>,{" "}
              <code className="font-mono">ANTHROPIC_API_KEY</code>,{" "}
              <code className="font-mono">DEEPSEEK_API_KEY</code>, or{" "}
              <code className="font-mono">GOOGLE_AI_API_KEY</code> (server-side,
              gitignored). See{" "}
              <code className="font-mono">.env.local.example</code> for details.
            </div>
          )}
          {state.user && modelConfigured === true && modelProvider && (
            <div className="mb-3 text-xs text-gray-500 dark:text-gray-400">
              Model: {modelProvider}
              {modelModel ? ` / ${modelModel}` : ""}
            </div>
          )}
          {state.user && modelError && (
            <div className="mb-3 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-800 dark:text-red-200">
              <strong>Model connection error.</strong> {modelError}
            </div>
          )}
          {state.user && citationValidationError && (
            <div className="mb-3 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              <strong>Citation validation error.</strong> {citationValidationError}
            </div>
          )}

          {/* Conversation */}
          {state.user && (
            <div className="mb-3 max-h-[300px] overflow-y-auto space-y-3 pr-1">
              {(conversations[state.user.id] ?? []).length === 0 && !asking && (
                <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">
                  No questions asked yet. Type a question below.
                </p>
              )}
              {(conversations[state.user.id] ?? []).map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                      msg.role === "user"
                        ? "bg-indigo-600 text-white"
                        : "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                    }`}
                  >
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                    {msg.citations.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {msg.citations.map((cit) => (
                          <button
                            key={cit.document_id}
                            onClick={() =>
                              handleSelectDocument(cit.document_id)
                            }
                            className="inline-flex items-center gap-1 rounded border border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/50 px-2 py-0.5 text-xs font-mono text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition"
                            title={cit.title}
                          >
                            {cit.document_id}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {asking && (
                <div className="flex justify-start">
                  <div className="rounded-lg bg-gray-100 dark:bg-gray-800 px-3 py-2 text-sm">
                    <span className="inline-flex items-center gap-1">
                      <svg
                        className="h-4 w-4 animate-spin text-gray-400"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <circle
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="3"
                          className="opacity-25"
                        />
                        <path
                          d="M12 2a10 10 0 0110 10"
                          stroke="currentColor"
                          strokeWidth="3"
                          className="opacity-75"
                        />
                      </svg>
                      Searching permitted sources...
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Question input */}
          {state.user && (
            <div className="flex gap-2">
              <input
                type="text"
                value={questionInput}
                onChange={(e) => setQuestionInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleAsk();
                  }
                }}
                placeholder="Ask a question about your available documents..."
                className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                disabled={asking}
              />
              <button
                onClick={handleAsk}
                disabled={asking || !questionInput.trim()}
                className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                Ask
              </button>
            </div>
          )}
        </section>

        {/* Main content: document list + viewer */}
        <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
          {/* Document List */}
          <aside className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Documents
              </h2>
              {state.user && !state.loadingDocs && (
                <span className="rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-1 text-xs font-medium">
                  {state.documents.length} available
                </span>
              )}
            </div>

            {!state.user && !state.loadingDocs && (
              <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">
                Select a demo user to view available documents.
              </p>
            )}

            {state.user && state.loadingDocs && (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-16 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse"
                  />
                ))}
              </div>
            )}

            {state.user && state.docError && (
              <p className="text-sm text-red-600 dark:text-red-400">
                {state.docError}
              </p>
            )}

            {state.user && !state.loadingDocs && !state.docError && (
              <ul className="space-y-1.5">
                {state.documents.map((doc) => (
                  <li key={doc.id}>
                    <button
                      onClick={() => handleSelectDocument(doc.id)}
                      className={`w-full text-left rounded-lg border px-3 py-2.5 transition ${
                        selectedDoc?.id === doc.id
                          ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/50"
                          : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            PLATFORM_COLORS[doc.platform] ??
                            "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {PLATFORM_LABELS[doc.platform] ?? doc.platform}
                        </span>
                        <span className="text-[10px] font-mono text-gray-400 dark:text-gray-500">
                          v{doc.version}
                        </span>
                      </div>
                      <div className="text-sm font-medium leading-snug line-clamp-2">
                        {doc.title}
                      </div>
                      <div className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
                        {doc.id} · {formatDate(doc.updated_at)}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          {/* Document Viewer */}
          <section className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 min-h-[400px]">
            {!state.user && (
              <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-500 text-sm">
                Select a demo user to begin.
              </div>
            )}

            {state.user && loadingDoc && (
              <div className="space-y-3">
                <div className="h-8 w-2/3 rounded bg-gray-100 dark:bg-gray-800 animate-pulse" />
                <div className="h-4 w-1/3 rounded bg-gray-100 dark:bg-gray-800 animate-pulse" />
                <div className="h-64 w-full rounded bg-gray-100 dark:bg-gray-800 animate-pulse mt-6" />
              </div>
            )}

            {state.user && docDetailError && !loadingDoc && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <svg
                  className="h-12 w-12 text-gray-300 dark:text-gray-700 mb-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                  />
                </svg>
                <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm">
                  {docDetailError}
                </p>
              </div>
            )}

            {state.user && !selectedDoc && !loadingDoc && !docDetailError && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <svg
                  className="h-12 w-12 text-gray-300 dark:text-gray-700 mb-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                  />
                </svg>
                <p className="text-sm text-gray-400 dark:text-gray-500">
                  Select a document from the list to view its content.
                </p>
              </div>
            )}

            {selectedDoc && (
              <article>
                {/* Document header */}
                <div className="mb-6 pb-4 border-b border-gray-200 dark:border-gray-800">
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                        PLATFORM_COLORS[selectedDoc.platform] ??
                        "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {PLATFORM_LABELS[selectedDoc.platform] ??
                        selectedDoc.platform}
                    </span>
                    <span className="text-xs font-mono text-gray-400 dark:text-gray-500">
                      {selectedDoc.id}
                    </span>
                  </div>
                  <h2 className="text-xl font-bold mb-3">
                    {selectedDoc.title}
                  </h2>
                  <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500">
                        Source
                      </dt>
                      <dd className="font-medium">
                        {PLATFORM_LABELS[selectedDoc.platform] ??
                          selectedDoc.platform}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500">
                        Version
                      </dt>
                      <dd className="font-medium">{selectedDoc.version}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500">
                        Updated
                      </dt>
                      <dd className="font-medium">
                        {formatDate(selectedDoc.updated_at)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500">
                        Source URL
                      </dt>
                      <dd className="font-medium text-xs truncate">
                        <a
                          href={selectedDoc.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                          {selectedDoc.source_url}
                        </a>
                      </dd>
                    </div>
                  </dl>
                </div>

                {/* Document content */}
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <MarkdownRenderer
                    content={selectedDoc.content_markdown}
                  />
                </div>

                {/* Related documents */}
                {selectedDoc.related_document_ids.length > 0 && (
                  <div className="mt-8 pt-4 border-t border-gray-200 dark:border-gray-800">
                    <h3 className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">
                      Related documents (filtered by your access)
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {selectedDoc.related_document_ids.map((relId) => (
                        <button
                          key={relId}
                          onClick={() => handleSelectDocument(relId)}
                          className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1 text-xs font-mono hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                        >
                          {relId}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </article>
            )}
          </section>
        </div>
      </main>

      <footer className="border-t border-gray-200 dark:border-gray-800 mt-auto">
        <div className="max-w-7xl mx-auto px-6 py-4 text-xs text-gray-400 dark:text-gray-500">
          Internal Brain — hackathon demo. All data is fictional. Baseline
          snapshot: 12 October 2026, 10:00 SGT.
        </div>
      </footer>
    </div>
  );
}

// Simple markdown renderer (headings, paragraphs, lists, tables, code, bold).
function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Table
    if (line.startsWith("|") && lines[i + 1]?.includes("---")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      const rows = tableLines.map((l) =>
        l
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim()),
      );
      const header = rows[0];
      const body = rows.slice(2);
      elements.push(
        <div key={key++} className="overflow-x-auto my-4">
          <table className="min-w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-300 dark:border-gray-700">
                {header.map((h, ci) => (
                  <th
                    key={ci}
                    className="text-left px-3 py-1.5 font-semibold"
                  >
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, ri) => (
                <tr
                  key={ri}
                  className="border-b border-gray-200 dark:border-gray-800"
                >
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-1.5">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,4})\s+(.*)/);
    if (hMatch) {
      const level = hMatch[1].length;
      const text = hMatch[2];
      if (level === 1)
        elements.push(
          <h1 key={key++} className="text-lg font-bold mb-3 mt-4">
            {renderInline(text)}
          </h1>,
        );
      else if (level === 2)
        elements.push(
          <h2 key={key++} className="text-base font-semibold mb-2 mt-4">
            {renderInline(text)}
          </h2>,
        );
      else
        elements.push(
          <h3
            key={key++}
            className="text-sm font-semibold mb-1.5 mt-3 text-gray-700 dark:text-gray-300"
          >
            {renderInline(text)}
          </h3>,
        );
      i++;
      continue;
    }

    // Code block
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre
          key={key++}
          className="bg-gray-100 dark:bg-gray-800 rounded p-3 my-2 overflow-x-auto text-xs font-mono"
        >
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Unordered list
    if (line.match(/^\s*[-*]\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\s*[-*]\s+/)) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      elements.push(
        <ul
          key={key++}
          className="list-disc pl-5 my-2 space-y-1 text-sm"
        >
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph (collect consecutive non-empty, non-special lines)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("|") &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith("```") &&
      !lines[i].match(/^\s*[-*]\s+/)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    elements.push(
      <p key={key++} className="text-sm leading-relaxed my-2">
        {renderInline(paraLines.join(" "))}
      </p>,
    );
  }

  return <>{elements}</>;
}

function renderInline(text: string): React.ReactNode {
  // Render `code`, **bold**, and [text](url) inline.
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/);
  return parts.map((part, idx) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={idx}
          className="bg-gray-100 dark:bg-gray-800 rounded px-1 py-0.5 text-xs font-mono"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={idx} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a
          key={idx}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-600 dark:text-indigo-400 hover:underline"
        >
          {linkMatch[1]}
        </a>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}
