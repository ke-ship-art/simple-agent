export type Protocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';
export type Provider = 'custom' | 'openai' | 'anthropic' | 'google' | 'github-copilot' | 'openrouter';
import type { ReasoningLevel } from './reasoning';
export interface ConnectionProfile { id: string; name: string; provider: Provider; protocol: Protocol; baseUrl: string; authMode: 'api_key' | 'oauth' | 'none'; hasCredential?: boolean; trustedHttp?: boolean; trustedAddresses?: string[]; credentialNamespace?: string; }
export interface ModelEntry { id: string; profileId: string; name: string; modelId: string; enabled: boolean; vision: boolean; reasoning: boolean; contextWindow: number; maxTokens: number; builtin?: boolean; reasoningLevel?: ReasoningLevel; supportedReasoningLevels?: ReasoningLevel[]; }
export interface Workspace { id: string; name: string; root: string; }
export interface DisplayMessage { id: string; role: 'user' | 'assistant' | 'tool' | 'notice'; text: string; modelName?: string; reasoningLevel?: ReasoningLevel; timestamp: number; }
export interface ResourceReference { type: 'resource'; resourceId: string; mimeType: 'image/png' | 'image/jpeg'; source: string; page?: number; version?: string; summary: string; bytes: number; }
export interface Session { id: string; workspaceId: string; title: string; modelId: string; messages: DisplayMessage[]; context: unknown[]; updatedAt: number; archivedAt?: number; deletedAt?: number; titleEdited?: boolean; }
export interface Change { path: string; before: string | null; beforeVersion?: string | null; after: string; status: 'prepared' | 'committed' | 'restoring' | 'restored' | 'conflict'; summary: string; diff?: string; recoveryError?: string; }
export interface ChangeSet { id: string; workspaceId: string; sessionId: string; createdAt: number; changes: Change[]; undone?: boolean; reviewedAt?: number; transaction?: {id: string; startIndex: number; status: 'applying' | 'rolling-back' | 'completed' | 'rolled-back' | 'conflict'; error?: string}; }
export interface Run { id: string; sessionId: string; modelId: string; reasoningLevel?: ReasoningLevel; status: 'running' | 'completed' | 'cancelled' | 'failed' | 'paused'; }
export interface NetworkSettings { enabled: boolean; proxyUrl: string; }
export interface AppState { profiles: ConnectionProfile[]; models: ModelEntry[]; workspaces: Workspace[]; sessions: Session[]; changeSets: ChangeSet[]; activeRun?: Run; lastRun?: Run; network?: NetworkSettings; recoveryWarnings?: string[]; }
export interface TreeEntry { path: string; name: string; directory: boolean; }
export interface TextDocument { kind: 'text'; path: string; version: string; text: string; bom: boolean; newline: string; }
export interface WordBlock { id: string; type: 'paragraph' | 'table-cell'; text: string; editable: boolean; reason?: string; runs?: {text: string; bold?: boolean; italic?: boolean; underline?: boolean}[]; style?: string; }
export interface WordDocument { kind: 'docx'; path: string; version: string; blocks: WordBlock[]; }
export interface SheetCell { ref: string; value: string; formula?: string; editable: boolean; style?: string; }
export interface Sheet { name: string; id: string; cells: SheetCell[]; merges: string[]; }
export interface ExcelDocument { kind: 'xlsx'; path: string; version: string; sheets: Sheet[]; needsRecalculation: boolean; recalculation?: {invalidated: string[]; preserved: number; reason: string}; }
export interface PdfDocument { kind: 'pdf'; path: string; version: string; pages: { number: number; width: number; height: number; rotation: number }[]; }
export type OpenDocument = TextDocument | WordDocument | ExcelDocument | PdfDocument;
export type FileOperation =
  | { type: 'replace'; oldText: string; newText: string }
  | { type: 'set_text'; text: string }
  | { type: 'word_replace'; blockId: string; oldText: string; newText: string; stylePolicy?: 'preserve' | 'first-run' }
  | { type: 'cell'; sheetId: string; ref: string; value: string; formula?: string }
  | { type: 'pdf_note'; page: number; x: number; y: number; text: string }
  | { type: 'pdf_text'; page: number; x: number; y: number; text: string; size?: number }
  | { type: 'pdf_pages'; pages: number[] }
  | { type: 'pdf_merge'; paths: string[] };
export interface PdfTask { id: string; bytes: Uint8Array; pages: number[]; render: boolean; }
export interface PdfResult { pages: { number: number; text: string; image?: string; annotations: string[] }[]; }
export type AppEvent =
  | { type: 'state' }
  | { type: 'session_purged'; sessionId: string }
  | { type: 'search_progress'; workspaceId: string; searchId: string; progress: {visited: number; scannedFiles: number; skippedFiles: number; bytesRead: number; hits: number; currentPath?: string} }
  | { type: 'delta'; sessionId: string; runId: string; messageId: string; text: string }
  | { type: 'auth'; profileId: string; authId: string; event: unknown }
  | { type: 'auth_prompt'; profileId: string; authId: string; promptId: string; prompt: { type: string; message: string; options?: readonly unknown[] } };
export interface Api {
  invoke<T = unknown>(method: string, args?: unknown): Promise<T>;
  onEvent(handler: (event: AppEvent) => void): () => void;
  onPdfTask(handler: (task: PdfTask) => void): () => void;
  pdfResult(id: string, result?: PdfResult, error?: string): void;
}
declare global { interface Window { agent: Api; } }
