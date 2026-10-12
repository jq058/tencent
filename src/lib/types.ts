// Shared type definitions for the Internal Brain demo app.
// These types describe the shape of the seed data and the
// client-facing API responses. Permission fields (acl, source_scope,
// users) are server-only and never sent to the browser.

export type Platform = "confluence" | "jira" | "slack" | "google_drive";

export interface SeedUser {
  id: string;
  display_name: string;
  role: string;
  group_ids: string[];
  synthetic: boolean;
  application_capabilities: string[];
  audit_scope_user_ids?: string[];
}

export interface Acl {
  policy_version: number;
  effective_reader_user_ids: string[];
  authority: string;
}

export interface SourceScope {
  type: string;
  [key: string]: unknown;
}

export interface SeedDocument {
  id: string;
  platform: Platform;
  title: string;
  source_url: string;
  source_url_kind: string;
  synthetic: boolean;
  company: string;
  version: number;
  updated_at: string;
  ingested_at: string | null;
  source_scope: SourceScope;
  acl: Acl;
  related_document_ids: string[];
  content_markdown: string;
}

export interface SeedData {
  schema_version: string;
  dataset_id: string;
  synthetic: boolean;
  company: string;
  timezone: string;
  snapshot_at: string;
  users: SeedUser[];
  documents: SeedDocument[];
}

// ── Client-facing types (no permission fields) ──────────────────

export interface ClientDocumentMeta {
  id: string;
  platform: Platform;
  title: string;
  version: number;
  updated_at: string;
}

export interface ClientDocumentDetail extends ClientDocumentMeta {
  source_url: string;
  content_markdown: string;
  related_document_ids: string[];
}

export interface DemoUser {
  id: string;
  display_name: string;
  role: string;
}

export interface SessionResponse {
  user: DemoUser | null;
  isDemo: true;
  label: string;
}

export interface DocumentListResponse {
  user_id: string;
  documents: ClientDocumentMeta[];
  count: number;
}

export interface ApiError {
  error: string;
}

// ── Q&A types ───────────────────────────────────────────────────

export interface Citation {
  document_id: string;
  title: string;
  platform: Platform;
  version: number;
}

export interface AskResponse {
  request_id: string;
  answer: string;
  citations: Citation[];
  model_configured: boolean;
  model_provider: string | null;
  model_model: string | null;
  model_context_document_ids: string[];
  model_error: string | null;
  citation_validation_error: string | null;
  rejected_citation_ids: string[];
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  timestamp: string;
  request_id?: string;
}
