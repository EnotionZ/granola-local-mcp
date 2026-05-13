/**
 * Thin client over api.granola.ai. Mirrors the request shape the real
 * Granola desktop client uses: Authorization: Bearer + X-Client-Version +
 * X-Granola-Platform. Retries once on 401 after invalidating the cached token.
 */

import { getAccessToken, invalidateToken } from "./auth.js";

const API_BASE = "https://api.granola.ai";
const CLIENT_VERSION = "7.205.1";
const PLATFORM = "macOS";

export interface GranolaDoc {
  id: string;
  created_at: string;
  updated_at?: string;
  title: string;
  user_id?: string;
  notes?: unknown;
  notes_plain?: string;
  notes_markdown?: string;
  overview?: string | null;
  summary?: string | null;
  people?: {
    creator?: { name?: string; email?: string };
    attendees?: Array<{
      email?: string;
      details?: { person?: { name?: { fullName?: string } } };
    }>;
  };
  google_calendar_event?: {
    summary?: string;
    description?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
  };
  deleted_at?: string | null;
  was_trashed?: boolean;
  valid_meeting?: boolean;
  status?: string;
  type?: string;
  [k: string]: unknown;
}

export interface GranolaPanel {
  document_id: string;
  id: string;
  title?: string;
  created_at?: string;
  /** Either a ProseMirror JSON doc (object) or an HTML string. */
  content?: unknown;
}

export interface GranolaTranscriptSegment {
  document_id: string;
  id: string;
  text: string;
  source: "system" | "microphone" | string;
  start_timestamp?: string;
  end_timestamp?: string;
  detected_speaker_name?: string | null;
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const doFetch = async (token: string) =>
    fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Client-Version": CLIENT_VERSION,
        "X-Granola-Platform": PLATFORM,
        "Accept-Encoding": "gzip",
      },
      body: JSON.stringify(body ?? {}),
    });

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err: any) {
    // Auth failure before any request — surface the auth error directly.
    throw new Error(`Authentication failed: ${err?.message ?? err}`);
  }

  let res = await doFetch(token);
  if (res.status === 401) {
    // Token was rejected. Invalidate and try to get a fresh one.
    invalidateToken();
    try {
      token = await getAccessToken();
    } catch (err: any) {
      throw new Error(
        `Granola API returned 401 (unauthorized) and token refresh also failed: ${err?.message ?? err}`
      );
    }
    res = await doFetch(token);
  }
  if (!res.ok) {
    const text = await res.text();
    const detail =
      res.status === 401
        ? "Your session may have expired. Try restarting this MCP server after signing in to the Granola desktop app."
        : `Details: ${text.slice(0, 400)}`;
    throw new Error(`Granola API ${path} failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as T;
}

export async function listDocuments(
  opts: {
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ docs: GranolaDoc[] }> {
  return call("/v2/get-documents", {
    limit: opts.limit ?? 100,
    offset: opts.offset ?? 0,
  });
}

/** Fetches every document by paging through /v2/get-documents. */
export async function listAllDocuments(pageSize = 100): Promise<GranolaDoc[]> {
  const all: GranolaDoc[] = [];
  let offset = 0;
  // Sanity cap to avoid runaway loops.
  for (let i = 0; i < 200; i++) {
    const { docs } = await listDocuments({ limit: pageSize, offset });
    all.push(...docs);
    if (docs.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

export async function getDocumentPanels(
  documentId: string
): Promise<GranolaPanel[]> {
  const out = await call<unknown>("/v1/get-document-panels", {
    document_id: documentId,
  });
  return Array.isArray(out) ? (out as GranolaPanel[]) : [];
}

export async function getDocumentTranscript(
  documentId: string
): Promise<GranolaTranscriptSegment[]> {
  const out = await call<unknown>("/v1/get-document-transcript", {
    document_id: documentId,
  });
  return Array.isArray(out) ? (out as GranolaTranscriptSegment[]) : [];
}
