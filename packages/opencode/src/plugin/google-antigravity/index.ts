import type { Auth, Model as ModelV2 } from "@opencode-ai/sdk/v2"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { OAUTH_DUMMY_KEY } from "../../auth"
import { beginAntigravityLogin, discoverAntigravityProject, refreshAntigravityToken } from "./oauth"
import {
  INTERNAL_SESSION_HEADER,
  isAntigravityModel,
  prepareAntigravityRequest,
  sendAntigravityRequest,
  stripInternalSessionHeader,
} from "./transport"

type OAuthAuth = Extract<Auth, { type: "oauth" }> & {
  projectId?: string
  accountId?: string
  email?: string
}

interface RefreshedAuth {
  access: string
  refresh: string
  expires: number
  projectId: string
  accountId?: string
  email?: string
}

function oauth(auth: Auth): OAuthAuth | undefined {
  return auth.type === "oauth" ? (auth as OAuthAuth) : undefined
}

function zeroCost(model: ModelV2): ModelV2 {
  return {
    ...model,
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
  }
}

export async function GoogleAntigravityAuthPlugin(input: PluginInput): Promise<Hooks> {
  let oauthEnabled = false

  return {
    provider: {
      id: "google",
      async models(provider, ctx) {
        if (ctx.auth?.type !== "oauth") return provider.models
        return Object.fromEntries(
          Object.entries(provider.models)
            .filter(([, model]) => isAntigravityModel(model.api.id))
            .map(([id, model]) => [id, zeroCost(model)]),
        )
      },
    },
    auth: {
      provider: "google",
      async loader(getAuth) {
        const initial = await getAuth()
        oauthEnabled = initial.type === "oauth"
        if (initial.type !== "oauth") return {}

        let refreshPromise: Promise<RefreshedAuth> | undefined

        const refresh = async (current: OAuthAuth): Promise<RefreshedAuth> => {
          if (!refreshPromise) {
            refreshPromise = refreshAntigravityToken(current.refresh, current.projectId)
              .then(async (next) => {
                const projectId = next.projectId ?? current.projectId
                if (!projectId) throw new Error("Google OAuth credential is missing its Cloud Code Assist project")
                const refreshed: RefreshedAuth = {
                  access: next.access,
                  refresh: next.refresh,
                  expires: next.expires,
                  projectId,
                  accountId: current.accountId,
                  email: current.email,
                }
                await input.client.auth.set({
                  path: { id: "google" },
                  body: { type: "oauth", ...refreshed } as any,
                })
                return refreshed
              })
              .finally(() => {
                refreshPromise = undefined
              })
          }
          return refreshPromise
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const currentOAuth = oauth(await getAuth())
            if (!currentOAuth) {
              oauthEnabled = false
              const [cleanInput, cleanInit] = stripInternalSessionHeader(requestInput, init)
              return fetch(cleanInput, cleanInit)
            }
            oauthEnabled = true

            let credential: RefreshedAuth | OAuthAuth = currentOAuth
            if (!credential.access || credential.expires <= Date.now() + 60_000) {
              credential = await refresh(currentOAuth)
            }

            let projectId = credential.projectId
            if (!projectId) {
              projectId = await discoverAntigravityProject(credential.access)
              if (!projectId) throw new Error("Could not discover a Cloud Code Assist project for the Google account")
              await input.client.auth.set({
                path: { id: "google" },
                body: { ...credential, type: "oauth", projectId } as any,
              })
            }

            const prepared = await prepareAntigravityRequest(requestInput, init)
            let response = await sendAntigravityRequest(prepared, credential.access, projectId)
            if (response.status !== 401) return response

            const latest = oauth(await getAuth()) ?? currentOAuth
            const refreshed = await refresh(latest)
            response = await sendAntigravityRequest(prepared, refreshed.access, refreshed.projectId)
            return response
          },
        }
      },
      methods: [
        {
          label: "Google AI Pro / Antigravity (browser)",
          type: "oauth",
          authorize: beginAntigravityLogin,
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
    "chat.headers": async (chat, output) => {
      if (!oauthEnabled || chat.model.providerID !== "google") return
      output.headers[INTERNAL_SESSION_HEADER] = chat.sessionID
    },
  }
}
