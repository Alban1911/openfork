import { createHash, randomUUID } from "node:crypto"

const CLOUD_CODE_ASSIST_API = "https://cloudcode-pa.googleapis.com"
export const INTERNAL_SESSION_HEADER = "x-opencode-antigravity-session"

export interface PreparedAntigravityRequest {
  method: "generateContent" | "streamGenerateContent"
  model: string
  body: Record<string, unknown>
  sessionId: string
  signal?: AbortSignal | null
}

export function mapAntigravityModel(model: string): string {
  if (model === "gemini-3.7-flash") return "gemini-3.7-flash-tiered"
  if (model === "gemini-3.1-pro" || model === "gemini-3.1-pro-high" || model === "gemini-3.1-pro-preview") {
    return "gemini-pro-agent"
  }
  if (model === "gemini-3.1-pro-low") return model
  if (/^gemini-3\.[56]-flash(?:-(?:extra-low|low|mid|medium|high))?$/.test(model)) {
    return "gemini-3.7-flash-tiered"
  }
  return model
}

export function isAntigravityModel(model: string) {
  return model.startsWith("gemini-")
}

export function stableSessionId(anchor: string): string {
  const digest = createHash("sha256").update(anchor, "utf8").digest()
  const masked = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn
  return `-${masked.toString()}`
}

function firstUserText(body: Record<string, unknown>): string | undefined {
  const contents = body.contents
  if (!Array.isArray(contents)) return
  for (const content of contents) {
    if (!content || typeof content !== "object" || (content as { role?: unknown }).role !== "user") continue
    const parts = (content as { parts?: unknown }).parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      const text = part && typeof part === "object" ? (part as { text?: unknown }).text : undefined
      if (typeof text === "string" && text.length > 0) return text
    }
  }
}

function requestUrl(input: RequestInfo | URL) {
  if (input instanceof URL) return input
  if (typeof input === "string") return new URL(input)
  return new URL(input.url)
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (typeof init?.body === "string") return init.body
  if (init?.body instanceof URLSearchParams) return init.body.toString()
  if (input instanceof Request) return input.clone().text()
  throw new Error("Google Antigravity transport expected a JSON request body")
}

function mergedHeaders(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  return headers
}

export async function prepareAntigravityRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<PreparedAntigravityRequest> {
  const url = requestUrl(input)
  const match = /\/models\/([^/:]+):(streamGenerateContent|generateContent)$/.exec(url.pathname)
  if (!match) throw new Error(`Unsupported Google request path for Antigravity: ${url.pathname}`)
  const raw = await requestBody(input, init)
  const body = JSON.parse(raw) as Record<string, unknown>
  const headers = mergedHeaders(input, init)
  const anchor = headers.get(INTERNAL_SESSION_HEADER) ?? firstUserText(body) ?? randomUUID()
  return {
    method: match[2] as PreparedAntigravityRequest["method"],
    model: mapAntigravityModel(decodeURIComponent(match[1])),
    body,
    sessionId: stableSessionId(anchor),
    signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
  }
}

function antigravityUserAgent() {
  const override = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT?.trim()
  if (override) return override
  const osType = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"
  const arch = process.arch === "x64" ? "amd64" : process.arch
  return `antigravity/ide/2.5.5 (os_type=${osType}; arch=${arch}; aidev_client; auth_method=oauth)`
}

export async function sendAntigravityRequest(
  prepared: PreparedAntigravityRequest,
  accessToken: string,
  projectId: string,
): Promise<Response> {
  const stream = prepared.method === "streamGenerateContent"
  const request = { ...prepared.body, sessionId: prepared.sessionId }
  const envelope = {
    model: prepared.model,
    userAgent: "antigravity",
    requestType: "agent",
    project: projectId,
    requestId: `agent-${randomUUID()}`,
    request,
  }
  const response = await fetch(
    `${CLOUD_CODE_ASSIST_API}/v1internal:${prepared.method}${stream ? "?alt=sse" : ""}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: stream ? "text/event-stream" : "application/json",
        "Content-Type": "application/json",
        "User-Agent": antigravityUserAgent(),
      },
      body: JSON.stringify(envelope),
      signal: prepared.signal ?? undefined,
    },
  )
  return unwrapAntigravityResponse(response)
}

function responseHeaders(response: Response) {
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return headers
}

export function unwrapAntigravityJson(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const nested = (value as { response?: unknown }).response
  return nested && typeof nested === "object" ? nested : value
}

export function unwrapAntigravitySseLine(line: string): string {
  if (!line.startsWith("data:")) return line
  const payload = line.slice(5).trim()
  if (!payload || payload === "[DONE]") return line
  try {
    return `data: ${JSON.stringify(unwrapAntigravityJson(JSON.parse(payload)))}`
  } catch {
    return line
  }
}

function unwrapSseBody(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          buffer += decoder.decode()
          if (buffer.length > 0) controller.enqueue(encoder.encode(unwrapAntigravitySseLine(buffer)))
          controller.close()
          return
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        if (lines.length === 0) continue
        controller.enqueue(encoder.encode(lines.map(unwrapAntigravitySseLine).join("\n") + "\n"))
        return
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
}

export async function unwrapAntigravityResponse(response: Response): Promise<Response> {
  if (!response.ok) return response
  const contentType = response.headers.get("content-type") ?? ""
  if (contentType.includes("text/event-stream") && response.body) {
    return new Response(unwrapSseBody(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response),
    })
  }
  if (contentType.includes("json")) {
    const value = await response.json()
    return new Response(JSON.stringify(unwrapAntigravityJson(value)), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response),
    })
  }
  return response
}

export function stripInternalSessionHeader(input: RequestInfo | URL, init?: RequestInit): [RequestInfo | URL, RequestInit?] {
  const headers = mergedHeaders(input, init)
  headers.delete(INTERNAL_SESSION_HEADER)
  return [input, { ...init, headers }]
}
