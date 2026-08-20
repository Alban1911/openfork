import { createServer } from "node:http"
import { randomBytes, createHash } from "node:crypto"

function oauthClient() {
  const clientId = process.env.GOOGLE_ANTIGRAVITY_CLIENT_ID?.trim()
  const clientSecret = process.env.GOOGLE_ANTIGRAVITY_CLIENT_SECRET?.trim()
  if (!clientId) {
    throw new Error("GOOGLE_ANTIGRAVITY_CLIENT_ID is required for Google Antigravity OAuth")
  }
  return { clientId, clientSecret }
}

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo"
const PROD_API = "https://cloudcode-pa.googleapis.com"
const DAILY_API = "https://daily-cloudcode-pa.googleapis.com"
const API_VERSION = "v1internal"
const CALLBACK_PORT = 51121
const CALLBACK_PATH = "/callback"
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`
const REQUEST_TIMEOUT_MS = 30_000
const REFRESH_SKEW_MS = 5 * 60 * 1000
const ONBOARD_ATTEMPTS = 5
const ONBOARD_POLL_MS = 2_000
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
]

export interface AntigravityCredentials {
  access: string
  refresh: string
  expires: number
  projectId?: string
  accountId?: string
  email?: string
}

interface GoogleTokenPayload {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  id_token?: unknown
}

interface PendingOAuth {
  verifier: string
  state: string
  resolve: (code: string) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof createServer> | undefined
let pendingOAuth: PendingOAuth | undefined

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function base64Url(input: Uint8Array | Buffer): string {
  return Buffer.from(input).toString("base64url")
}

export function generatePKCE() {
  const verifier = base64Url(randomBytes(32))
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

function renderResult(title: string, detail: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${detail}</p><script>window.setTimeout(() => window.close(), 1200)</script></body></html>`
}

async function startOAuthServer(): Promise<void> {
  if (oauthServer) return
  oauthServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`)
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404)
      res.end("Not found")
      return
    }

    const error = url.searchParams.get("error")
    const errorDescription = url.searchParams.get("error_description")
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")

    if (error) {
      const message = errorDescription || error
      pendingOAuth?.reject(new Error(message))
      pendingOAuth = undefined
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(renderResult("Google authorization failed", message))
      return
    }

    if (!pendingOAuth || !code || state !== pendingOAuth.state) {
      const message = !code ? "Missing authorization code" : "Invalid OAuth state"
      pendingOAuth?.reject(new Error(message))
      pendingOAuth = undefined
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      res.end(renderResult("Google authorization failed", message))
      return
    }

    const pending = pendingOAuth
    pendingOAuth = undefined
    pending.resolve(code)
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderResult("Google authorization complete", "You can return to OpenCode."))
  })

  await new Promise<void>((resolve, reject) => {
    oauthServer!.once("error", reject)
    oauthServer!.listen(CALLBACK_PORT, "127.0.0.1", () => resolve())
  })
}

function stopOAuthServer() {
  oauthServer?.close()
  oauthServer = undefined
  pendingOAuth = undefined
}

function waitForOAuthCode(verifier: string, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingOAuth = undefined
      reject(new Error("Google authorization timed out"))
    }, 5 * 60 * 1000)

    pendingOAuth = {
      verifier,
      state,
      resolve(code) {
        clearTimeout(timeout)
        resolve(code)
      },
      reject(error) {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
}

async function postToken(body: Record<string, string>, signal?: AbortSignal): Promise<GoogleTokenPayload> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: requestSignal(signal),
  })
  if (!response.ok) throw new Error(`Google token request failed (${response.status})`)
  return (await response.json()) as GoogleTokenPayload
}

function credentialsFromPayload(payload: GoogleTokenPayload, refreshFallback = ""): AntigravityCredentials {
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("Google token response did not include an access token")
  }
  const refresh =
    typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
      ? payload.refresh_token
      : refreshFallback
  if (!refresh) throw new Error("Google token response did not include a refresh token")
  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600
  return {
    access: payload.access_token,
    refresh,
    expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
  }
}

export function extractProjectId(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data[key]
    if (typeof value === "string" && value.length > 0) return value
    if (value && typeof value === "object") {
      const id = (value as { id?: unknown }).id
      if (typeof id === "string" && id.length > 0) return id
    }
  }
}

function antigravityUserAgent() {
  const override = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT?.trim()
  if (override) return override
  const osType = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"
  const arch = process.arch === "x64" ? "amd64" : process.arch
  return `antigravity/ide/2.5.5 (os_type=${osType}; arch=${arch}; aidev_client; auth_method=oauth)`
}

async function loadCodeAssistProject(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
  const response = await fetch(`${PROD_API}/${API_VERSION}:loadCodeAssist`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "*/*",
      "Content-Type": "application/json",
      "User-Agent": antigravityUserAgent(),
    },
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
    signal: requestSignal(signal),
  })
  if (!response.ok) return
  return extractProjectId((await response.json().catch(() => undefined)) as Record<string, unknown> | undefined)
}

async function onboardProject(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
  for (let attempt = 0; attempt < ONBOARD_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("Google onboarding aborted")
    const response = await fetch(`${DAILY_API}/${API_VERSION}:onboardUser`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "*/*",
        "Content-Type": "application/json",
        "User-Agent": antigravityUserAgent(),
      },
      body: JSON.stringify({
        tier_id: "free-tier",
        metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity", ide_version: "2.5.5" },
      }),
      signal: requestSignal(signal),
    })

    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        await new Promise((resolve) => setTimeout(resolve, ONBOARD_POLL_MS))
        continue
      }
      return
    }

    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
    const direct = extractProjectId(data)
    if (direct) return direct
    if (data.done === true) {
      const project = extractProjectId(data.response as Record<string, unknown> | undefined)
      if (project) return project
    }
    await new Promise((resolve) => setTimeout(resolve, ONBOARD_POLL_MS))
  }
}

export async function discoverAntigravityProject(accessToken: string, signal?: AbortSignal) {
  return (await loadCodeAssistProject(accessToken, signal)) ?? (await onboardProject(accessToken, signal))
}

async function fetchIdentity(accessToken: string, signal?: AbortSignal) {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    signal: requestSignal(signal),
  })
  if (!response.ok) return {}
  const data = (await response.json().catch(() => ({}))) as { id?: unknown; email?: unknown }
  return {
    accountId: typeof data.id === "string" ? data.id : undefined,
    email: typeof data.email === "string" ? data.email.toLowerCase() : undefined,
  }
}

export async function beginAntigravityLogin() {
  await startOAuthServer()
  const pkce = generatePKCE()
  const state = base64Url(randomBytes(32))
  const codePromise = waitForOAuthCode(pkce.verifier, state)
  const client = oauthClient()
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent select_account",
    state,
  })

  return {
    url: `${AUTH_ENDPOINT}?${params.toString()}`,
    instructions: "Complete Google authorization in your browser. The window will close automatically.",
    method: "auto" as const,
    async callback() {
      try {
        const code = await codePromise
        const payload = await postToken({
          grant_type: "authorization_code",
          client_id: client.clientId,
          ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: pkce.verifier,
        })
        const credentials = credentialsFromPayload(payload)
        const [projectId, identity] = await Promise.all([
          discoverAntigravityProject(credentials.access),
          fetchIdentity(credentials.access),
        ])
        if (!projectId) {
          throw new Error(
            "Google authorization succeeded, but no Cloud Code Assist project was discovered for this account.",
          )
        }
        return {
          type: "success" as const,
          ...credentials,
          ...identity,
          projectId,
        }
      } finally {
        stopOAuthServer()
      }
    },
  }
}

export async function refreshAntigravityToken(
  refreshToken: string,
  currentProjectId?: string,
  signal?: AbortSignal,
): Promise<AntigravityCredentials> {
  if (!refreshToken) throw new Error("Google OAuth credential does not include a refresh token")
  const client = oauthClient()
  const payload = await postToken(
    {
      grant_type: "refresh_token",
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      refresh_token: refreshToken,
    },
    signal,
  )
  const credentials = credentialsFromPayload(payload, refreshToken)
  const projectId = currentProjectId ?? (await discoverAntigravityProject(credentials.access, signal))
  return { ...credentials, projectId }
}
