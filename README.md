# granola-local-mcp

A local-first MCP server for [Granola](https://granola.ai). It reads the
encrypted credentials from your Granola installation, refreshes the WorkOS
token automatically, and calls Granola's API on your behalf. No API key or
manual login required.

## Tools

- **list_meetings** — paged list of meetings (id, title, date, attendees).
  Supports `since`/`until` (ISO 8601), `limit`, `offset`, `include_deleted`.
- **get_meeting** — one meeting as markdown: title, date, attendees, AI
  summary panels, and full speaker-labeled transcript.
- **get_meeting_transcript** — transcript only, as markdown.
- **search_meetings** — substring search over titles and attendee names/emails.

## How auth works

1. On first use, reads the `Granola Safe Storage` entry from your macOS
   keychain. macOS will pop a dialog the first time — click **Always Allow**.
2. Decrypts `~/Library/Application Support/Granola/storage.dek` using
   Electron's safeStorage format (AES-128-CBC, PBKDF2-SHA1, salt `saltysalt`,
   1003 iterations).
3. AES-256-GCM-decrypts `supabase.json.enc` with the DEK to retrieve the
   stored WorkOS tokens.
4. If the access token is within 5 minutes of expiry, refreshes it via
   `https://auth.granola.ai/user_management/authenticate`.
5. Caches the access token in memory for the life of the process.

No tokens are written back to disk — Granola itself manages persistence.

## Setup

```sh
cd ~/Work/llm/granola-local-mcp
npm install
npm run build
```

## Wiring into a client

### Claude Desktop / Cowork

Add to your MCP config:

```json
{
  "mcpServers": {
    "granola-local": {
      "command": "node",
      "args": ["/path/to/granola-local-mcp/dist/index.js"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add granola-local node /path/to/granola-local-mcp/dist/index.js
```

## Caveats

- macOS only. The keychain + safeStorage code is Apple-specific.
- The Granola API surface used here is undocumented and may change. The
  client version is pinned at `7.205.1`; bump it in `src/api.ts` if Granola
  starts rejecting requests as "Unsupported client".
- Search is a cheap substring match on titles/attendees. For full-content
  search, run `list_meetings` + `get_meeting` and let the model read.
