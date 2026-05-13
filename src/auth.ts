/**
 * Auth + crypto for Granola's local store.
 *
 * Flow:
 *   1. Read the "Granola Safe Storage" entry from the macOS keychain. This is
 *      Electron's safeStorage key. The first call will trigger a one-time
 *      "Always Allow" keychain prompt unless the user already allowed it.
 *   2. Decrypt storage.dek (AES-128-CBC, Electron's safeStorage format) using a
 *      PBKDF2-derived key. The plaintext is a base64 string of the 32-byte DEK.
 *   3. AES-256-GCM-decrypt supabase.json.enc using the DEK. That JSON holds
 *      both cognito_tokens and workos_tokens; we use workos_tokens.
 *   4. If the WorkOS access token is close to expiry, refresh it via
 *      https://auth.granola.ai/user_management/authenticate with grant_type=refresh_token.
 *
 * Tokens are cached in memory for the life of the process and re-decrypted on
 * startup. We never write tokens back to disk — the running Granola app owns
 * persistence.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";

const execFileAsync = promisify(execFile);

const GRANOLA_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "Granola"
);
const DEK_PATH = join(GRANOLA_DIR, "storage.dek");
const SUPABASE_ENC = join(GRANOLA_DIR, "supabase.json.enc");

// Electron safeStorage on macOS uses AES-128-CBC with these constants.
const ELECTRON_SAFE_STORAGE_PREFIX = Buffer.from("v10");
const ELECTRON_PBKDF2 = {
  salt: Buffer.from("saltysalt"),
  iterations: 1003,
  keyLen: 16,
  digest: "sha1" as const,
};
const ELECTRON_IV = Buffer.alloc(16, 0x20); // 16 spaces

// AES-256-GCM constants for Granola's per-file encryption.
const GCM_IV_LEN = 12;
const GCM_TAG_LEN = 16;

// Refresh proactively when this much time is left.
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

export interface WorkOsTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  obtained_at: number;
  token_type?: string;
  session_id?: string;
  external_id?: string;
}

interface JwtPayload {
  exp?: number;
  iat?: number;
  client_id?: string;
  [k: string]: unknown;
}

function decodeJwt(token: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Not a JWT");
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

async function readKeychainPassword(service: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
      "-w",
    ]);
    return stdout.trim();
  } catch (err: any) {
    throw new Error(
      `Could not read "${service}" from the macOS keychain. ` +
        `If a permission dialog appeared, click "Always Allow" and retry. ` +
        `Underlying error: ${err?.message ?? err}`
    );
  }
}

function decryptElectronSafeStorage(blob: Buffer, password: string): Buffer {
  // Strip "v10" prefix if present.
  const ciphertext = blob.subarray(0, 3).equals(ELECTRON_SAFE_STORAGE_PREFIX)
    ? blob.subarray(3)
    : blob;
  const key = pbkdf2Sync(
    password,
    ELECTRON_PBKDF2.salt,
    ELECTRON_PBKDF2.iterations,
    ELECTRON_PBKDF2.keyLen,
    ELECTRON_PBKDF2.digest
  );
  const decipher = createDecipheriv("aes-128-cbc", key, ELECTRON_IV);
  // safeStorage uses PKCS7 padding which Node's CBC mode strips automatically.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function decryptGcmFile(blob: Buffer, dek: Buffer): Buffer {
  const iv = blob.subarray(0, GCM_IV_LEN);
  const tag = blob.subarray(blob.length - GCM_TAG_LEN);
  const ciphertext = blob.subarray(GCM_IV_LEN, blob.length - GCM_TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", dek, iv, {
    authTagLength: GCM_TAG_LEN,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function loadDek(): Promise<Buffer> {
  const safeStoragePassword = await readKeychainPassword(
    "Granola Safe Storage"
  );
  const dekBlob = await readFile(DEK_PATH);
  const plaintext = decryptElectronSafeStorage(dekBlob, safeStoragePassword);
  const dek = Buffer.from(plaintext.toString("utf8"), "base64");
  if (dek.length !== 32) {
    throw new Error(
      `Unexpected DEK length: ${dek.length} (expected 32). ` +
        `Granola may have changed its storage format.`
    );
  }
  return dek;
}

async function loadEncryptedTokens(): Promise<{
  cognito_tokens?: string;
  workos_tokens?: string;
  session_id?: string;
}> {
  const dek = await loadDek();
  const blob = await readFile(SUPABASE_ENC);
  const plaintext = decryptGcmFile(blob, dek);
  return JSON.parse(plaintext.toString("utf8"));
}

/**
 * Returns true if the WorkOS error indicates the refresh token itself is
 * expired or revoked — i.e. the user must re-authenticate in the Granola app.
 */
function isPermanentRefreshError(status: number, body: string): boolean {
  if (status === 400 || status === 401) {
    try {
      const j = JSON.parse(body);
      const err = j?.error ?? "";
      return ["invalid_grant", "invalid_token", "unauthorized_client"].includes(
        err
      );
    } catch {
      // Can't parse — assume permanent if 4xx.
      return true;
    }
  }
  return false;
}

const REAUTH_GUIDANCE =
  "Your Granola session has expired and cannot be refreshed automatically. " +
  "Open the Granola desktop app, sign in again, then restart this MCP server.";

async function refreshWorkOsToken(
  refreshToken: string,
  clientId: string
): Promise<WorkOsTokens> {
  let res: Response;
  try {
    res = await fetch("https://auth.granola.ai/user_management/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
  } catch (err: any) {
    throw new Error(
      `Could not reach Granola auth server to refresh token: ${err?.message ?? err}. ` +
        "Check your network connection and try again."
    );
  }
  if (!res.ok) {
    const text = await res.text();
    if (isPermanentRefreshError(res.status, text)) {
      throw new Error(REAUTH_GUIDANCE);
    }
    throw new Error(
      `Granola token refresh failed (${res.status}). ` +
        "This may be temporary — try again in a moment. " +
        `Details: ${text.slice(0, 300)}`
    );
  }
  const json: any = await res.json();
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in ?? 3600,
    obtained_at: Date.now(),
    token_type: json.token_type,
  };
}

function tokenIsFresh(t: WorkOsTokens): boolean {
  const exp = decodeJwt(t.access_token).exp;
  if (!exp) return false;
  const msUntilExp = exp * 1000 - Date.now();
  return msUntilExp > TOKEN_REFRESH_WINDOW_MS;
}

let cached: WorkOsTokens | null = null;
let refreshInFlight: Promise<WorkOsTokens> | null = null;

/**
 * Returns a current WorkOS access token. Reads from disk + keychain on first
 * call, then keeps a memory cache. If the cached token is within 5 minutes of
 * expiry, refreshes it in the background. Concurrent callers share the
 * refresh.
 */
export async function getAccessToken(): Promise<string> {
  if (cached && tokenIsFresh(cached)) {
    return cached.access_token;
  }
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      let enc: Awaited<ReturnType<typeof loadEncryptedTokens>>;
      try {
        enc = await loadEncryptedTokens();
      } catch (err: any) {
        throw new Error(
          `Failed to read Granola credentials from disk: ${err?.message ?? err}. ` +
            "Make sure the Granola desktop app is installed and you have signed in at least once."
        );
      }
      if (!enc.workos_tokens) {
        throw new Error(
          "No Granola credentials found on disk. " +
            "Open the Granola desktop app and sign in, then restart this MCP server."
        );
      }
      let stored: WorkOsTokens;
      try {
        stored = JSON.parse(enc.workos_tokens) as WorkOsTokens;
      } catch {
        throw new Error(
          "Granola credentials on disk are corrupted. " +
            "Open the Granola desktop app and sign in again, then restart this MCP server."
        );
      }
      // If the stored token is still fresh, just use it.
      if (tokenIsFresh(stored)) {
        return stored;
      }
      const clientId = decodeJwt(stored.access_token).client_id;
      if (typeof clientId !== "string") {
        throw new Error(
          "Cannot determine WorkOS client_id from stored token. " +
            "The stored credentials may be in an unexpected format. " +
            "Try signing in again in the Granola desktop app."
        );
      }
      try {
        return await refreshWorkOsToken(stored.refresh_token, clientId);
      } catch (err: any) {
        // If the error already contains guidance (e.g. REAUTH_GUIDANCE),
        // re-throw as-is. Otherwise wrap with context.
        throw err;
      }
    })().finally(() => {
      // Allow next refresh attempt after this one settles.
      const finished = refreshInFlight;
      // Defer cache assignment until after .then() runs below.
      void finished;
    });
  }
  const fresh = await refreshInFlight;
  refreshInFlight = null;
  cached = fresh;
  return fresh.access_token;
}

/** Force-invalidate the cached token (e.g. on a 401). */
export function invalidateToken(): void {
  cached = null;
}
