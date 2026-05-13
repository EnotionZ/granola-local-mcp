// Minimal MCP stdio client that exercises every tool. Run with:
//   node scripts/smoke.mjs

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "dist", "index.js");

const child = spawn("node", [serverEntry], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function note(name, val) {
  const s = typeof val === "string" ? val : JSON.stringify(val, null, 2);
  console.log(`\n=== ${name} ===\n${s.length > 1500 ? s.slice(0, 1500) + "\n...[truncated]" : s}`);
}

async function main() {
  // 1. Initialize
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  note("initialize", init.result?.serverInfo ?? init);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // 2. List tools
  const tools = await rpc("tools/list", {});
  note("tools/list", tools.result?.tools?.map((t) => t.name) ?? tools);

  // 3. list_meetings (last 5)
  const list = await rpc("tools/call", { name: "list_meetings", arguments: { limit: 5 } });
  const listText = list.result?.content?.[0]?.text ?? JSON.stringify(list);
  note("list_meetings(limit=5)", listText);
  let parsed;
  try { parsed = JSON.parse(listText); } catch {}
  const firstId = parsed?.meetings?.[0]?.id;
  const firstTitle = parsed?.meetings?.[0]?.title;

  if (!firstId) {
    note("first meeting", "no meetings returned");
    child.kill();
    return;
  }

  // 4. search_meetings — search for first attendee name or part of title
  const q = (firstTitle || "").split(/[\s/]+/)[0] || "Dom";
  const search = await rpc("tools/call", { name: "search_meetings", arguments: { query: q, limit: 3 } });
  note(`search_meetings("${q}")`, search.result?.content?.[0]?.text);

  // 5. get_meeting_transcript — just the head
  const tx = await rpc("tools/call", { name: "get_meeting_transcript", arguments: { document_id: firstId } });
  const txText = tx.result?.content?.[0]?.text ?? "";
  note(`get_meeting_transcript(${firstId})`, txText);

  // 6. get_meeting — full markdown
  const full = await rpc("tools/call", { name: "get_meeting", arguments: { document_id: firstId } });
  const fullText = full.result?.content?.[0]?.text ?? "";
  note(`get_meeting(${firstId})`, fullText);

  child.kill();
}

main().catch((e) => {
  console.error("smoke failed:", e);
  child.kill();
  process.exit(1);
});
