# Google Antigravity OAuth

This built-in OpenCode provider routes the existing `@ai-sdk/google` Gemini transport through Google Cloud Code Assist (Antigravity) without running OpenCodex or another local proxy.

## Local configuration

Set the OAuth client values before launching the fork:

```powershell
$env:GOOGLE_ANTIGRAVITY_CLIENT_ID = "<installed-app OAuth client id>"
$env:GOOGLE_ANTIGRAVITY_CLIENT_SECRET = "<installed-app OAuth client secret>"
```

The client secret is optional for Google installed-app clients that do not require one. The client id is mandatory. Credentials are intentionally not committed because repository secret protection rejects OAuth client credentials.

The redirect URI expected by the provider is:

```text
http://127.0.0.1:51121/callback
```

Then run OpenCode and select:

```text
Google → Google AI Pro / Antigravity (browser)
```

OAuth tokens, the account identifier and the discovered Cloud Code Assist project id are stored in OpenCode's existing protected `auth.json` store.

## Attribution

The OAuth/project-discovery behavior and Cloud Code Assist wire format were adapted from `lidge-jun/opencodex`. Its MIT notice is preserved in `LICENSE.opencodex`.
