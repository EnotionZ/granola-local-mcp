#!/usr/bin/env node
/**
 * granola-local-mcp — stdio MCP server exposing Granola tools.
 *
 * Tools:
 *   - list_meetings(limit?, offset?, since?)
 *   - get_meeting(document_id)              full markdown: summary + transcript
 *   - get_meeting_transcript(document_id)   transcript only
 *   - search_meetings(query, limit?)        substring search over cached docs
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  listAllDocuments,
  getDocumentPanels,
  getDocumentTranscript,
  type GranolaDoc,
} from "./api.js";
import {
  buildMeetingMarkdown,
  extractAttendees,
  formatTranscript,
} from "./markdown.js";

// In-memory document cache. Refreshed on demand. The cache is keyed by doc id
// so list_meetings can return summaries without re-paging the API every call.
interface DocCache {
  fetchedAt: number;
  byId: Map<string, GranolaDoc>;
  ordered: GranolaDoc[]; // in API order (newest first)
}
const CACHE_TTL_MS = 60 * 1000; // refresh list every minute at most
let docCache: DocCache | null = null;
let cacheRefresh: Promise<DocCache> | null = null;

async function getDocs(force = false): Promise<DocCache> {
  if (!force && docCache && Date.now() - docCache.fetchedAt < CACHE_TTL_MS) {
    return docCache;
  }
  if (!cacheRefresh) {
    cacheRefresh = (async () => {
      const docs = await listAllDocuments();
      const byId = new Map<string, GranolaDoc>();
      for (const d of docs) byId.set(d.id, d);
      const cache: DocCache = { fetchedAt: Date.now(), byId, ordered: docs };
      docCache = cache;
      return cache;
    })().finally(() => {
      cacheRefresh = null;
    });
  }
  return cacheRefresh;
}

function summarizeDoc(d: GranolaDoc) {
  const attendees = extractAttendees(d);
  return {
    id: d.id,
    title: d.title,
    created_at: d.created_at,
    updated_at: d.updated_at,
    attendees: attendees.map((a) => ({ name: a.name, email: a.email })),
    deleted: !!d.deleted_at || !!d.was_trashed,
  };
}

function filterByDate(docs: GranolaDoc[], since?: string, until?: string): GranolaDoc[] {
  if (!since && !until) return docs;
  const lo = since ? Date.parse(since) : -Infinity;
  const hi = until ? Date.parse(until) : Infinity;
  return docs.filter((d) => {
    const t = Date.parse(d.created_at);
    return Number.isFinite(t) && t >= lo && t <= hi;
  });
}

const TOOLS = [
  {
    name: "list_meetings",
    description:
      "List Granola meetings (newest first). Returns id, title, created_at, attendees. " +
      "Use `since`/`until` (ISO 8601) to bound by created_at, and `limit`/`offset` for pagination. " +
      "Set `include_deleted: true` to include trashed meetings (excluded by default).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
        offset: { type: "integer", minimum: 0, default: 0 },
        since: { type: "string", description: "ISO 8601, inclusive lower bound on created_at" },
        until: { type: "string", description: "ISO 8601, inclusive upper bound on created_at" },
        include_deleted: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "get_meeting",
    description:
      "Get one meeting as markdown — title, date, attendees, AI summary panels, and full transcript. " +
      "Pass the meeting `document_id` (UUID).",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "Meeting UUID" },
      },
      required: ["document_id"],
    },
  },
  {
    name: "get_meeting_transcript",
    description:
      "Return only the speaker-labeled transcript for one meeting, as markdown. " +
      "Pass the meeting `document_id` (UUID).",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "Meeting UUID" },
      },
      required: ["document_id"],
    },
  },
  {
    name: "search_meetings",
    description:
      "Substring search over cached meeting titles and attendee names/emails. " +
      "Cheap, no transcript scanning — use list_meetings + get_meeting for deeper digs. " +
      "Returns at most `limit` matches (default 25).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 25 },
      },
      required: ["query"],
    },
  },
] as const;

type ToolName =
  | "list_meetings"
  | "get_meeting"
  | "get_meeting_transcript"
  | "search_meetings";

async function callTool(name: ToolName, args: Record<string, unknown>) {
  switch (name) {
    case "list_meetings": {
      const limit = Math.min(Number(args.limit ?? 50), 500);
      const offset = Math.max(Number(args.offset ?? 0), 0);
      const includeDeleted = !!args.include_deleted;
      const since = typeof args.since === "string" ? args.since : undefined;
      const until = typeof args.until === "string" ? args.until : undefined;
      const cache = await getDocs();
      let docs = cache.ordered;
      if (!includeDeleted) docs = docs.filter((d) => !d.deleted_at && !d.was_trashed);
      docs = filterByDate(docs, since, until);
      const total = docs.length;
      const page = docs.slice(offset, offset + limit).map(summarizeDoc);
      return {
        total,
        offset,
        limit,
        meetings: page,
      };
    }
    case "get_meeting": {
      const id = String(args.document_id ?? "");
      if (!id) throw new Error("document_id is required");
      const cache = await getDocs();
      let doc = cache.byId.get(id);
      if (!doc) {
        // Cache miss — refresh once in case it was just created.
        const fresh = await getDocs(true);
        doc = fresh.byId.get(id);
      }
      if (!doc) throw new Error(`No meeting with id ${id}`);
      const [panels, transcript] = await Promise.all([
        getDocumentPanels(id),
        getDocumentTranscript(id),
      ]);
      return { markdown: buildMeetingMarkdown(doc, panels, transcript) };
    }
    case "get_meeting_transcript": {
      const id = String(args.document_id ?? "");
      if (!id) throw new Error("document_id is required");
      const transcript = await getDocumentTranscript(id);
      return { markdown: formatTranscript(transcript) };
    }
    case "search_meetings": {
      const q = String(args.query ?? "").trim().toLowerCase();
      if (!q) throw new Error("query is required");
      const limit = Math.min(Number(args.limit ?? 25), 200);
      const cache = await getDocs();
      const hits: { doc: GranolaDoc; matched: string }[] = [];
      for (const d of cache.ordered) {
        if (d.deleted_at || d.was_trashed) continue;
        const titleHit = (d.title ?? "").toLowerCase().includes(q);
        let attendeeHit = false;
        if (!titleHit) {
          for (const a of extractAttendees(d)) {
            if (
              a.name.toLowerCase().includes(q) ||
              a.email.toLowerCase().includes(q)
            ) {
              attendeeHit = true;
              break;
            }
          }
        }
        if (titleHit || attendeeHit) {
          hits.push({ doc: d, matched: titleHit ? "title" : "attendee" });
          if (hits.length >= limit) break;
        }
      }
      return {
        query: q,
        count: hits.length,
        matches: hits.map((h) => ({ ...summarizeDoc(h.doc), matched_on: h.matched })),
      };
    }
  }
}

const server = new Server(
  { name: "granola-local-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await callTool(name as ToolName, (args ?? {}) as Record<string, unknown>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [
        { type: "text", text: `Error: ${err?.message ?? String(err)}` },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// Log to stderr (stdout is reserved for the MCP framing).
console.error("[granola-local-mcp] connected over stdio");
