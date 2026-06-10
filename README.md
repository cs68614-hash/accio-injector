# Accio Injector PoC

Small proof of concept for injecting a loader/runtime into a copied Accio Electron app bundle, following the Codex++ approach.

The injector does not modify `/Applications/Accio.app` by default. It copies Accio to a target app, patches the copied `app.asar`, writes a local runtime/config directory, and launches the copied app.

## What Is Committed

Commit these files:

- `src/`
- `runtime/`
- `package.json`
- `package-lock.json`
- `config.example.json`
- `.gitignore`
- `README.md`

Do not commit these:

- `dist/`
- `node_modules/`
- `*.app`
- local `config.json`
- logs

The real API key should live only in the generated local `config.json`, or in an environment variable referenced by `apiKeyEnv`.

## Install On A New Mac

Requirements:

- macOS
- Node.js 20+
- Accio installed at `/Applications/Accio.app`
- Xcode command line tools, for `codesign`

Clone and install:

```sh
git clone <your-repo-url> accio-injector
cd accio-injector
npm install
```

Inject a copied app:

```sh
npm run inject -- \
  --source /Applications/Accio.app \
  --target "$HOME/Applications/Accio-injected.app" \
  --user-root "$HOME/Library/Application Support/accio-injector" \
  --skip-launch
```

On first run, the injector creates:

```text
$HOME/Library/Application Support/accio-injector/config.json
```

Edit that file for your model routing:

```json
{
  "requestProbe": {
    "enabled": true,
    "logAll": false
  },
  "llmProxy": {
    "enabled": true,
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "gpt-4.1",
    "passthroughModel": false,
    "sseHeartbeatMs": 25000,
    "exposeReasoning": false
  },
  "embeddingProxy": {
    "enabled": true,
    "model": "text-embedding-3-small",
    "dimensions": 1536,
    "fallback": "synthetic"
  }
}
```

Then launch:

```sh
OPENAI_API_KEY="your-key" /usr/bin/open -n "$HOME/Applications/Accio-injected.app"
```

Or put an `apiKey` directly in the local config if you accept storing it on that machine. Do not commit that file.

Verify injection:

```sh
npm run verify -- --user-root "$HOME/Library/Application Support/accio-injector"
```

Watch network/proxy logs:

```sh
tail -f "$HOME/Library/Application Support/accio-injector/log/network.log"
```

If Accio trips the 90s SSE idle watchdog during long generations, lower
`llmProxy.sseHeartbeatMs` so the proxy sends periodic heartbeat bytes while
waiting for the upstream model.

## What It Patches

- `app.asar/package.json#main` becomes `accio-injector-loader.cjs`.
- The original main entry is preserved in `package.json#__accioInjector.originalMain`.
- `ElectronAsarIntegrity["Resources/app.asar"].hash` is updated.
- Electron fuse `EnableEmbeddedAsarIntegrityValidation` is flipped off in the copied app.
- The copied app is ad-hoc signed after patching.
- When using Accio's `Resources/app_source` as the repack source, missing files are restored from the original `app.asar`.

## LLM And Embedding Proxy

The model path observed in Accio is:

```text
POST https://phoenix-gw.alibaba.com/api/adk/llm/generateContent?...
```

The proxy converts Accio's ADK/Gemini-style `generateContent` request to OpenAI-compatible `/chat/completions`, then converts the OpenAI SSE stream back to Accio-style SSE.

The embedding path observed in Accio is:

```text
POST https://pre-phoenix-gw.alibaba-inc.com/api/adk/embedding/embed
```

The embedding proxy tries `${baseUrl}/embeddings` first and can fall back to deterministic synthetic vectors if the upstream endpoint does not support embeddings.

Restart the injected Accio app after changing `config.json`.
