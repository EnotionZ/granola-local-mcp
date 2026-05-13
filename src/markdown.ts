/**
 * Convert Granola panel content + transcripts into markdown.
 * Panels come in two shapes: ProseMirror JSON (object) or HTML (string).
 */

import type {
  GranolaDoc,
  GranolaPanel,
  GranolaTranscriptSegment,
} from "./api.js";

interface PmNode {
  type?: string;
  text?: string;
  attrs?: Record<string, any>;
  content?: PmNode[];
  marks?: Array<{ type: string; attrs?: Record<string, any> }>;
}

export function proseMirrorToMarkdown(node: unknown, depth = 0): string {
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) {
    return node.map((n) => proseMirrorToMarkdown(n, depth)).join("");
  }
  const n = node as PmNode;
  const content = n.content ?? [];
  const t = n.type;
  switch (t) {
    case "doc":
      return content.map((c) => proseMirrorToMarkdown(c, depth)).join("");
    case "paragraph":
      return content.map((c) => proseMirrorToMarkdown(c, depth)).join("") + "\n\n";
    case "heading": {
      const level = n.attrs?.level ?? 2;
      return (
        "#".repeat(level) +
        " " +
        content.map((c) => proseMirrorToMarkdown(c, depth)).join("") +
        "\n\n"
      );
    }
    case "bulletList":
      return content.map((c) => proseMirrorToMarkdown(c, depth)).join("") + (depth === 0 ? "\n" : "");
    case "orderedList":
      return content
        .map((c, i) => {
          const inner = proseMirrorToMarkdown(c.content ?? [], depth + 1).trimEnd();
          return "  ".repeat(depth) + `${i + 1}. ` + inner + "\n";
        })
        .join("") + (depth === 0 ? "\n" : "");
    case "listItem": {
      const inner = content.map((c) => proseMirrorToMarkdown(c, depth + 1)).join("");
      const [first, ...rest] = inner.split("\n\n");
      let out = "  ".repeat(depth) + "- " + first + "\n";
      const tail = rest.join("\n\n").trimEnd();
      if (tail) out += tail + "\n";
      return out;
    }
    case "blockquote": {
      const inner = content.map((c) => proseMirrorToMarkdown(c, depth)).join("");
      return inner.split("\n").map((l) => "> " + l).join("\n") + "\n\n";
    }
    case "codeBlock":
      return "```\n" + content.map((c) => proseMirrorToMarkdown(c, depth)).join("") + "\n```\n\n";
    case "hardBreak":
      return "  \n";
    case "text": {
      let text = n.text ?? "";
      for (const mark of n.marks ?? []) {
        switch (mark.type) {
          case "bold":
          case "strong":
            text = `**${text}**`;
            break;
          case "italic":
          case "em":
            text = `*${text}*`;
            break;
          case "code":
            text = `\`${text}\``;
            break;
          case "link": {
            const href = mark.attrs?.href ?? "";
            text = `[${text}](${href})`;
            break;
          }
        }
      }
      return text;
    }
    default:
      return content.map((c) => proseMirrorToMarkdown(c, depth)).join("");
  }
}

export function htmlToMarkdown(html: string): string {
  let s = html;
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/gi, (_m, lvl, body) => "#".repeat(Number(lvl)) + " " + body + "\n\n");
  s = s.replace(/<\/?(?:ul|ol)[^>]*>/gi, "\n");
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, body) => "- " + body.trim() + "\n");
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, body) => body + "\n\n");
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**");
  s = s.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "*$2*");
  s = s.replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  s = s.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

export function panelToMarkdown(panel: GranolaPanel): string {
  const c = panel.content;
  if (!c) return "";
  if (typeof c === "string") return htmlToMarkdown(c);
  if (typeof c === "object") return proseMirrorToMarkdown(c).trimEnd();
  return "";
}

export interface Attendee {
  name: string;
  email: string;
  role: "creator" | "attendee";
}

export function extractAttendees(doc: GranolaDoc): Attendee[] {
  const people = doc.people;
  if (!people) return [];
  const out: Attendee[] = [];
  if (people.creator) {
    out.push({
      name: people.creator.name ?? "",
      email: people.creator.email ?? "",
      role: "creator",
    });
  }
  for (const a of people.attendees ?? []) {
    out.push({
      name: a.details?.person?.name?.fullName ?? "",
      email: a.email ?? "",
      role: "attendee",
    });
  }
  return out;
}

export function formatTranscript(segments: GranolaTranscriptSegment[]): string {
  if (!segments.length) return "_No transcript available._";
  const lines: string[] = [];
  let curSpeaker: string | null = null;
  let curText: string[] = [];
  const flush = () => {
    if (curSpeaker !== null) lines.push(`**${curSpeaker}:** ${curText.join(" ")}`);
  };
  for (const seg of segments) {
    const speaker =
      seg.detected_speaker_name ||
      (seg.source === "microphone" ? "Me" : "Other");
    const text = (seg.text ?? "").trim();
    if (!text) continue;
    if (speaker === curSpeaker) {
      curText.push(text);
    } else {
      flush();
      curSpeaker = speaker;
      curText = [text];
    }
  }
  flush();
  return lines.join("\n\n");
}

function formatDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(0, 16);
}

export function buildMeetingMarkdown(
  doc: GranolaDoc,
  panels: GranolaPanel[],
  transcript: GranolaTranscriptSegment[],
): string {
  const attendees = extractAttendees(doc);
  const out: string[] = [];
  out.push(`# ${doc.title || "Untitled"}`, "");
  out.push(`**Date:** ${formatDate(doc.created_at)}`);
  if (attendees.length) {
    const line = attendees.map((a) => a.name || a.email).filter(Boolean).join(", ");
    out.push(`**Attendees:** ${line}`);
  }
  out.push(`**ID:** \`${doc.id}\``, "");
  out.push("## Summary", "");
  if (panels.length === 0) {
    out.push("_No AI summary available._", "");
  } else {
    for (const p of panels) {
      out.push(`### ${p.title ?? "Notes"}`, "");
      const md = panelToMarkdown(p);
      out.push(md || "_(empty)_", "");
    }
  }
  out.push("## Transcript", "");
  out.push(formatTranscript(transcript), "");
  return out.join("\n");
}
