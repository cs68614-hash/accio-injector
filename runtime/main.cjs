/* eslint-disable */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const http = require("node:http");
const https = require("node:https");
const electron = require("electron");

const userRoot = process.env.ACCIO_INJECTOR_USER_ROOT;
const runtimeDir = process.env.ACCIO_INJECTOR_RUNTIME;
const preloadPath = path.join(runtimeDir || "", "preload.cjs");
const bodyPreviewLimit = 4096;

const appConfig = loadConfig();
const defaultProbeConfig = {
  enabled: true,
  logAll: false,
  hosts: [
    "phoenix-gw.alibaba.com",
    "pre-phoenix-gw.alibaba-inc.com",
    "localhost:7001",
    "127.0.0.1:7001",
  ],
  pathHints: [
    "/api/tool/rlab/call",
    "chat",
    "completion",
    "completions",
    "conversation",
    "gateway",
    "llm",
    "model",
    "stream",
  ],
};

const probeConfig = normalizeProbeConfig(appConfig.requestProbe || appConfig.networkProbe || appConfig);
const llmProxyConfig = normalizeLlmProxyConfig(appConfig.llmProxy);
const embeddingProxyConfig = normalizeEmbeddingProxyConfig(appConfig.embeddingProxy, llmProxyConfig);

function log(message, extra) {
  try {
    const logDir = path.join(userRoot || "", "log");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, "main.log"),
      `[${new Date().toISOString()}] ${message}${extra === undefined ? "" : " " + JSON.stringify(extra)}\n`,
    );
  } catch {}
}

function networkLog(event, extra) {
  try {
    if (!probeConfig.enabled) return;
    const logDir = path.join(userRoot || "", "log");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, "network.log"),
      `[${new Date().toISOString()}] ${event}${extra === undefined ? "" : " " + JSON.stringify(redact(extra))}\n`,
    );
  } catch {}
}

function loadConfig() {
  try {
    const file = path.join(userRoot || "", "config.json");
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    log("config load failed", { error: error && error.message || String(error) });
    return {};
  }
}

function normalizeProbeConfig(config) {
  const merged = { ...defaultProbeConfig };
  if (config && typeof config === "object") {
    Object.assign(merged, config);
    if (!Array.isArray(merged.hosts)) merged.hosts = defaultProbeConfig.hosts;
    if (!Array.isArray(merged.pathHints)) merged.pathHints = defaultProbeConfig.pathHints;
  }
  return merged;
}

function normalizeLlmProxyConfig(config) {
  const proxy = config && typeof config === "object" ? config : {};
  const apiKey = proxy.apiKey || (proxy.apiKeyEnv ? process.env[proxy.apiKeyEnv] : undefined) || process.env.ACCIO_INJECTOR_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const heartbeatMs = Number(
    proxy.sseHeartbeatMs
    || process.env.ACCIO_INJECTOR_OPENAI_SSE_HEARTBEAT_MS
    || 25000,
  );
  return {
    enabled: !!proxy.enabled,
    baseUrl: String(proxy.baseUrl || process.env.ACCIO_INJECTOR_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey,
    model: proxy.model || process.env.ACCIO_INJECTOR_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4.1",
    timeoutMs: Number(proxy.timeoutMs || process.env.ACCIO_INJECTOR_OPENAI_TIMEOUT_MS || 120000),
    sseHeartbeatMs: Number.isFinite(heartbeatMs) ? heartbeatMs : 25000,
    passthroughModel: !!proxy.passthroughModel,
    injectSystemPrompt: proxy.injectSystemPrompt || "",
    exposeReasoning: proxy.exposeReasoning === true || process.env.ACCIO_INJECTOR_EXPOSE_REASONING === "1",
  };
}

function normalizeEmbeddingProxyConfig(config, llmConfig) {
  const proxy = config && typeof config === "object" ? config : {};
  return {
    enabled: proxy.enabled !== undefined ? !!proxy.enabled : !!llmConfig.enabled,
    baseUrl: String(proxy.baseUrl || llmConfig.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: proxy.apiKey || (proxy.apiKeyEnv ? process.env[proxy.apiKeyEnv] : undefined) || llmConfig.apiKey,
    model: proxy.model || process.env.ACCIO_INJECTOR_EMBEDDING_MODEL || "text-embedding-3-small",
    dimensions: Number(proxy.dimensions || process.env.ACCIO_INJECTOR_EMBEDDING_DIMENSIONS || 1536),
    fallback: proxy.fallback || "synthetic",
  };
}

function isAdkGenerateContentUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.endsWith("/api/adk/llm/generateContent")
      || parsed.pathname.endsWith("/api/adk/llm/generateContent/");
  } catch {
    return String(url).includes("/api/adk/llm/generateContent");
  }
}

function isAdkEmbeddingUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.endsWith("/api/adk/embedding/embed")
      || parsed.pathname.endsWith("/api/adk/embedding/embed/");
  } catch {
    return String(url).includes("/api/adk/embedding/embed");
  }
}

function redact(value) {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object") return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("authorization")
      || lower.includes("cookie")
      || lower.includes("token")
      || lower.includes("apikey")
      || lower.includes("api-key")
      || lower.includes("secret")
      || lower.includes("password")
    ) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = redact(item);
    }
  }
  return out;
}

function redactString(text) {
  return text
    .replace(/([?&](?:accessToken|token|authToken|apiKey|api_key|secret|password)=)[^&\s"]+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(sk-[A-Za-z0-9._-]{12,})/g, "[REDACTED_API_KEY]")
    .replace(/("?(?:token|accessToken|authToken|apiKey|api_key|password|secret)"?\s*[:=]\s*")([^"]+)(")/gi, "$1[REDACTED]$3");
}

function headersToObject(headers) {
  if (!headers) return undefined;
  try {
    if (typeof headers.forEach === "function") {
      const out = {};
      headers.forEach((value, key) => {
        out[key] = value;
      });
      return out;
    }
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    if (typeof headers === "object") return { ...headers };
  } catch {}
  return undefined;
}

function previewBody(body) {
  try {
    if (body == null) return undefined;
    if (typeof body === "string") return summarizeBodyText(body);
    if (Buffer.isBuffer(body)) return summarizeBodyText(body.toString("utf8"));
    if (body instanceof URLSearchParams) return truncate(body.toString());
    if (ArrayBuffer.isView(body)) return summarizeBodyText(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8"));
    if (body instanceof ArrayBuffer) return summarizeBodyText(Buffer.from(body).toString("utf8"));
    if (typeof body === "object" && body.constructor?.name) return `[${body.constructor.name}]`;
  } catch (error) {
    return `[unreadable body: ${error && error.message || String(error)}]`;
  }
  return `[${typeof body}]`;
}

function summarizeBodyText(text) {
  const clean = String(text);
  const summarized = summarizeJsonBody(clean);
  if (summarized) return summarized;
  return truncate(clean);
}

function summarizeJsonBody(text) {
  try {
    const json = JSON.parse(text);
    if (!json || typeof json !== "object") return undefined;
    const keys = Object.keys(json);
    const summary = { kind: "json", keys };

    if (json.model) summary.model = json.model;
    if (json.function) summary.function = json.function;
    if (json.request?.method) summary.requestMethod = json.request.method;

    if (Array.isArray(json.messages)) {
      summary.messages = json.messages.map(summarizeMessage);
      return JSON.stringify(summary);
    }

    if (Array.isArray(json.contents)) {
      summary.contents = json.contents.map(summarizeGeminiContent);
      if (json.systemInstruction) summary.systemInstruction = summarizeGeminiContent(json.systemInstruction);
      if (json.generationConfig) summary.generationConfig = json.generationConfig;
      if (Array.isArray(json.tools)) summary.tools = json.tools.map(summarizeTool);
      return JSON.stringify(summary);
    }

    if (json.request?.params || json.request?.body || json.request?.arguments) {
      summary.request = summarizeLooseObject(json.request, 2);
      return JSON.stringify(summary);
    }

    if (json.payload) {
      summary.payload = summarizeLooseObject(json.payload, 2);
      return JSON.stringify(summary);
    }
  } catch {}
  return undefined;
}

function summarizeMessage(message) {
  if (!message || typeof message !== "object") return typeof message;
  return {
    role: message.role,
    content: typeof message.content === "string"
      ? `[text ${message.content.length} chars]`
      : summarizeLooseObject(message.content, 2),
    tool_calls: Array.isArray(message.tool_calls) ? `[${message.tool_calls.length} tool calls]` : undefined,
  };
}

function summarizeGeminiContent(content) {
  if (!content || typeof content !== "object") return typeof content;
  return {
    role: content.role,
    parts: Array.isArray(content.parts)
      ? content.parts.map((part) => {
          if (part?.text) return { text: `[text ${String(part.text).length} chars]` };
          if (part?.function_call) {
            return {
              function_call: {
                name: part.function_call.name,
                args: summarizeLooseObject(parseMaybeJson(part.function_call.args_json) ?? part.function_call.args, 1),
              },
            };
          }
          if (part?.function_response) {
            return {
              function_response: {
                name: part.function_response.name,
                response: summarizeLooseObject(parseMaybeJson(part.function_response.response_json) ?? part.function_response.response, 1),
              },
            };
          }
          if (part?.inline_data) return { inline_data: { mime_type: part.inline_data.mime_type, data: "[base64]" } };
          return summarizeLooseObject(part, 1);
        })
      : undefined,
  };
}

function summarizeTool(tool) {
  if (!tool || typeof tool !== "object") return typeof tool;
  if (Array.isArray(tool.function_declarations)) {
    return {
      function_declarations: tool.function_declarations.map((item) => ({
        name: item?.name,
        descriptionLength: item?.description ? String(item.description).length : 0,
        parametersKeys: item?.parameters ? Object.keys(item.parameters) : undefined,
      })),
    };
  }
  return summarizeLooseObject(tool, 1);
}

function summarizeLooseObject(value, depth) {
  if (value == null) return value;
  if (typeof value === "string") return `[text ${value.length} chars]`;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return depth <= 0 ? `[array ${value.length}]` : value.slice(0, 8).map((item) => summarizeLooseObject(item, depth - 1));
  if (depth <= 0) return `{object ${Object.keys(value).length} keys}`;
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    out[key] = summarizeLooseObject(item, depth - 1);
  }
  return out;
}

function parseMaybeJson(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function truncate(text) {
  const clean = String(text);
  if (clean.length <= bodyPreviewLimit) return clean;
  return `${clean.slice(0, bodyPreviewLimit)}... [truncated ${clean.length - bodyPreviewLimit} chars]`;
}

function normalizeUrl(input, options) {
  try {
    if (typeof input === "string" || input instanceof URL) return new URL(input.toString()).toString();
    if (input?.url) return new URL(input.url).toString();
  } catch {}

  try {
    const protocol = options?.protocol || input?.protocol || "https:";
    const host = options?.hostname || options?.host || input?.hostname || input?.host || "unknown";
    const port = options?.port || input?.port;
    const pathName = options?.path || input?.path || "/";
    return `${protocol}//${host}${port && !String(host).includes(":") ? `:${port}` : ""}${pathName}`;
  } catch {}

  return String(input);
}

function shouldLogUrl(url) {
  if (probeConfig.logAll) return true;
  try {
    const parsed = new URL(url);
    const host = parsed.host.toLowerCase();
    const href = parsed.href.toLowerCase();
    if (probeConfig.hosts.some((candidate) => host === String(candidate).toLowerCase())) return true;
    return probeConfig.pathHints.some((hint) => href.includes(String(hint).toLowerCase()));
  } catch {
    const text = String(url).toLowerCase();
    return probeConfig.pathHints.some((hint) => text.includes(String(hint).toLowerCase()));
  }
}

function installFetchProbe() {
  const original = globalThis.fetch;
  if (typeof original !== "function" || original.__accioInjectorWrapped) return;
  globalThis.fetch = wrapFetchFunction(original, "global.fetch");
  networkLog("probe installed", { layer: "global.fetch" });
}

function wrapFetchFunction(fetchFn, label) {
  if (typeof fetchFn !== "function" || fetchFn.__accioInjectorWrapped) return fetchFn;

  const wrapped = async function accioInjectorFetch(input, init) {
    const url = normalizeUrl(input);
    const shouldLog = shouldLogUrl(url);
    if (llmProxyConfig.enabled && isAdkGenerateContentUrl(url)) {
      return proxyAdkLlmFetch(fetchFn, input, init, url, label);
    }
    if (embeddingProxyConfig.enabled && isAdkEmbeddingUrl(url)) {
      return proxyEmbeddingFetch(fetchFn, input, init, url, label);
    }
    if (shouldLog) {
      networkLog("fetch request", {
        layer: label,
        method: init?.method || input?.method || "GET",
        url,
        headers: headersToObject(init?.headers || input?.headers),
        bodyPreview: previewBody(init?.body),
      });
    }

    try {
      const response = await fetchFn.apply(this, arguments);
      if (shouldLog) {
        networkLog("fetch response", {
          layer: label,
          url,
          status: response?.status,
          ok: response?.ok,
          headers: headersToObject(response?.headers),
        });
      }
      return response;
    } catch (error) {
      if (shouldLog) {
        networkLog("fetch error", {
          layer: label,
          url,
          error: error && error.stack || String(error),
        });
      }
      throw error;
    }
  };

  try {
    Object.defineProperty(wrapped, "__accioInjectorWrapped", { value: true });
    Object.setPrototypeOf(wrapped, Object.getPrototypeOf(fetchFn));
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(fetchFn));
  } catch {}
  return wrapped;
}

async function proxyEmbeddingFetch(fetchFn, input, init, url, label) {
  const started = Date.now();
  const bodyText = String(init?.body || input?.body || "{}");
  networkLog("embedding proxy request", {
    layer: label,
    url,
    targetBaseUrl: embeddingProxyConfig.baseUrl,
    targetModel: embeddingProxyConfig.model,
    hasApiKey: !!embeddingProxyConfig.apiKey,
    bodyPreview: previewBody(bodyText),
  });

  try {
    const original = JSON.parse(bodyText);
    if (embeddingProxyConfig.apiKey) {
      const response = await fetchFn.call(globalThis, `${embeddingProxyConfig.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${embeddingProxyConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: embeddingProxyConfig.model,
          input: original.input,
        }),
        signal: init?.signal || input?.signal,
      });
      networkLog("embedding proxy upstream response", {
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - started,
        headers: headersToObject(response.headers),
      });
      if (response.ok) return response;
      if (embeddingProxyConfig.fallback !== "synthetic") return response;
    }

    return new Response(JSON.stringify(createSyntheticEmbeddingResponse(original)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    networkLog("embedding proxy error", {
      url,
      error: error && error.stack || String(error),
    });
    if (embeddingProxyConfig.fallback === "synthetic") {
      return new Response(JSON.stringify(createSyntheticEmbeddingResponse({ input: "" })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return jsonErrorResponse(500, error && error.message || String(error));
  }
}

function createSyntheticEmbeddingResponse(request) {
  const inputs = Array.isArray(request.input) ? request.input : [request.input ?? ""];
  return {
    object: "list",
    model: embeddingProxyConfig.model,
    data: inputs.map((text, index) => ({
      object: "embedding",
      index,
      embedding: syntheticEmbedding(String(text), embeddingProxyConfig.dimensions),
    })),
    usage: {
      prompt_tokens: Math.max(1, Math.ceil(inputs.join(" ").length / 4)),
      total_tokens: Math.max(1, Math.ceil(inputs.join(" ").length / 4)),
    },
  };
}

function syntheticEmbedding(text, dimensions) {
  const out = new Array(dimensions);
  let state = 2166136261;
  for (let i = 0; i < text.length; i++) {
    state ^= text.charCodeAt(i);
    state = Math.imul(state, 16777619) >>> 0;
  }
  for (let i = 0; i < dimensions; i++) {
    state ^= i + 0x9e3779b9;
    state = Math.imul(state, 16777619) >>> 0;
    out[i] = ((state / 0xffffffff) * 2 - 1) / Math.sqrt(dimensions);
  }
  return out;
}

async function proxyAdkLlmFetch(fetchFn, input, init, url, label) {
  const started = Date.now();
  networkLog("llm proxy request", {
    layer: label,
    url,
    targetBaseUrl: llmProxyConfig.baseUrl,
    targetModel: llmProxyConfig.model,
    hasApiKey: !!llmProxyConfig.apiKey,
    bodyPreview: previewBody(init?.body || input?.body),
  });

  if (!llmProxyConfig.apiKey) {
    return jsonErrorResponse(500, "llmProxy enabled but no API key was provided");
  }

  try {
    const adkRequest = JSON.parse(String(init?.body || input?.body || "{}"));
    const openAiRequest = convertAdkRequestToOpenAi(adkRequest);
    const response = await fetchFn.call(globalThis, `${llmProxyConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${llmProxyConfig.apiKey}`,
      },
      body: JSON.stringify(openAiRequest),
      signal: init?.signal || input?.signal,
    });

    networkLog("llm proxy upstream response", {
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - started,
      headers: headersToObject(response.headers),
    });

    if (!response.ok) return response;
    if (!response.body) return jsonErrorResponse(502, "OpenAI-compatible response had no body");
    return new Response(openAiStreamToAdkStream(response.body), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream;charset=UTF-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "close",
      },
    });
  } catch (error) {
    networkLog("llm proxy error", {
      url,
      error: error && error.stack || String(error),
    });
    return jsonErrorResponse(500, error && error.message || String(error));
  }
}

function jsonErrorResponse(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function convertAdkRequestToOpenAi(adkRequest) {
  const messages = [];
  const system = adkRequest.system_instruction || adkRequest.systemInstruction;
  if (system) messages.push({ role: "system", content: String(system) });
  if (llmProxyConfig.injectSystemPrompt) {
    messages.push({ role: "system", content: String(llmProxyConfig.injectSystemPrompt) });
  }

  for (const content of adkRequest.contents || []) {
    appendOpenAiMessages(messages, content);
  }

  const body = {
    model: llmProxyConfig.passthroughModel
      ? adkRequest.model || llmProxyConfig.model
      : llmProxyConfig.model,
    messages,
    stream: true,
  };

  const temperature = adkRequest.temperature ?? adkRequest.generation_config?.temperature;
  const maxTokens = adkRequest.max_output_tokens ?? adkRequest.maxOutputTokens ?? adkRequest.generation_config?.max_output_tokens;
  const topP = adkRequest.top_p ?? adkRequest.topP;
  const stop = adkRequest.stop_sequences ?? adkRequest.stopSequences;
  if (temperature !== undefined) body.temperature = temperature;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (topP !== undefined) body.top_p = topP;
  if (Array.isArray(stop) && stop.length) body.stop = stop;

  const tools = convertAdkTools(adkRequest.tools);
  if (tools.length) body.tools = tools;
  const toolChoice = adkRequest.tool_choice || adkRequest.toolChoice;
  if (toolChoice) body.tool_choice = convertToolChoice(toolChoice);

  const responseFormat = adkRequest.response_format || adkRequest.responseFormat;
  if (responseFormat === "json_object") body.response_format = { type: "json_object" };

  return body;
}

function appendOpenAiMessages(messages, content) {
  const role = content?.role;
  const parts = Array.isArray(content?.parts) ? content.parts : [];

  if (role === "model" || role === "assistant") {
    const text = collapseRepeatedText(parts
      .filter((part) => !part.thought)
      .map((part) => part.text)
      .filter(Boolean)
      .join(""));
    const toolCalls = parts
      .map((part) => part.function_call || part.functionCall)
      .filter(Boolean)
      .map((call) => ({
        id: call.id || `call_${Math.random().toString(36).slice(2)}`,
        type: "function",
        function: {
          name: call.name || "",
          arguments: call.args_json || call.argsJson || JSON.stringify(call.args || {}),
        },
      }));
    messages.push({
      role: "assistant",
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
    return;
  }

  const functionResponses = parts
    .map((part) => part.function_response || part.functionResponse)
    .filter(Boolean);
  if (functionResponses.length) {
    for (const response of functionResponses) {
      messages.push({
        role: "tool",
        tool_call_id: response.id || "",
        name: response.name || undefined,
        content: response.response_json || response.responseJson || JSON.stringify(response.response || {}),
      });
    }
    return;
  }

  const userParts = [];
  for (const part of parts) {
    if (part.text) userParts.push({ type: "text", text: String(part.text) });
    else if (part.inline_data?.data || part.inlineData?.data) userParts.push({ type: "text", text: "[image omitted by accio-injector]" });
    else if (part.file_data?.file_uri || part.fileData?.fileUri) userParts.push({ type: "text", text: `[file omitted: ${part.file_data?.file_uri || part.fileData?.fileUri}]` });
  }
  messages.push({
    role: "user",
    content: userParts.length <= 1 ? (userParts[0]?.text || "") : userParts,
  });
}

function convertAdkTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    const parameters = parseMaybeJson(tool.parameters_json || tool.parametersJson) || {};
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters,
      },
    };
  }).filter((tool) => tool.function.name);
}

function collapseRepeatedText(text) {
  const source = String(text || "");
  if (!source) return "";

  const paragraphs = source.split(/(\n{2,})/);
  const out = [];
  let lastParagraph = "";
  for (const chunk of paragraphs) {
    if (/^\n{2,}$/.test(chunk)) {
      if (out.length && !/^\n{2,}$/.test(out[out.length - 1])) out.push(chunk);
      continue;
    }
    const normalized = chunk.trim().replace(/\s+/g, " ");
    if (normalized && normalized === lastParagraph) continue;
    out.push(chunk);
    if (normalized) lastParagraph = normalized;
  }

  return out.join("").replace(/([^\n.!?。！？]{20,}[.!?。！？])(?:\s*\1){1,}/g, "$1");
}

function convertToolChoice(choice) {
  if (choice === "any") return "required";
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  return { type: "function", function: { name: String(choice) } };
}

function openAiStreamToAdkStream(openAiBody) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let completed = false;
  let heartbeatTimer = null;
  const toolCalls = new Map();
  const textState = { emitted: "" };
  const reasoningState = { emitted: "" };

  return new ReadableStream({
    async start(controller) {
      try {
        if (llmProxyConfig.sseHeartbeatMs > 0) {
          heartbeatTimer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": accio-injector heartbeat\n\n"));
            } catch {}
          }, llmProxyConfig.sseHeartbeatMs);
        }
        for await (const chunk of openAiBody) {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            const delta = choice?.delta || {};
            captureToolCallDeltas(toolCalls, delta.tool_calls);
            const reasoningDelta = normalizeStreamDelta(reasoningState, delta.reasoning_content);
            if (reasoningDelta && llmProxyConfig.exposeReasoning) enqueueAdk(controller, encoder, {
              content: { role: "model", parts: [{ text: reasoningDelta, thought: true }] },
              turnComplete: false,
              partial: true,
              rawResponseJson: data,
            });
            const textDelta = normalizeStreamDelta(textState, delta.content);
            if (textDelta) enqueueAdk(controller, encoder, {
              content: { role: "model", parts: [{ text: textDelta, thought: false }] },
              turnComplete: false,
              partial: true,
              rawResponseJson: data,
            });
            if (choice?.finish_reason) {
              enqueueFinalFrame(controller, encoder, choice.finish_reason, toolCalls, parsed.usage);
              completed = true;
            }
          }
        }
        if (!completed) enqueueFinalFrame(controller, encoder, "stop", toolCalls);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        enqueueAdk(controller, encoder, {
          errorCode: "ACCIO_INJECTOR_PROXY_ERROR",
          errorMessage: error && error.message || String(error),
          turnComplete: true,
          partial: false,
          finishReason: "error",
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      }
    },
  });
}

function captureToolCallDeltas(toolCalls, deltas) {
  if (!Array.isArray(deltas)) return;
  for (const delta of deltas) {
    const key = delta.index ?? delta.id ?? 0;
    const current = toolCalls.get(key) || { id: delta.id, name: "", arguments: "", argumentsObject: undefined };
    if (delta.id) current.id = delta.id;
    if (delta.function?.name) current.name += delta.function.name;
    if (typeof delta.function?.arguments === "string") {
      current.arguments += delta.function.arguments;
    } else if (delta.function?.arguments && typeof delta.function.arguments === "object") {
      current.argumentsObject = {
        ...(current.argumentsObject || {}),
        ...delta.function.arguments,
      };
    }
    toolCalls.set(key, current);
  }
}

function normalizeStreamDelta(state, value) {
  if (!value) return "";
  const text = String(value);

  if (!state.emitted) {
    state.emitted = text;
    return text;
  }

  if (text.startsWith(state.emitted)) {
    const suffix = text.slice(state.emitted.length);
    state.emitted = text;
    return suffix;
  }

  const overlap = suffixPrefixOverlap(state.emitted, text);
  const suffix = text.slice(overlap);
  state.emitted += suffix;
  return suffix;
}

function suffixPrefixOverlap(left, right) {
  const max = Math.min(left.length, right.length, 8192);
  for (let size = max; size > 0; size--) {
    if (left.slice(-size) === right.slice(0, size)) return size;
  }
  return 0;
}

function enqueueFinalFrame(controller, encoder, finishReason, toolCalls, usage) {
  const parts = [];
  const dropped = [];
  for (const call of toolCalls.values()) {
    const args = normalizeToolCallArgs(call);
    if (call.name === "bash" && (!args.command || typeof args.command !== "string" || !args.command.trim())) {
      dropped.push({ name: call.name, reason: "missing command", rawArgumentsLength: String(call.arguments || "").length });
      continue;
    }
    parts.push({
      function_call: {
        id: sanitizeToolCallId(call.id || `call_${Math.random().toString(36).slice(2)}`),
        name: call.name,
        args,
        args_json: JSON.stringify(args),
      },
      thought: false,
    });
  }
  if (parts.length || dropped.length) {
    networkLog("llm proxy tool calls", {
      finishReason,
      calls: parts.map((part) => ({
        name: part.function_call.name,
        argKeys: Object.keys(part.function_call.args || {}),
        argsPreview: summarizeLooseObject(part.function_call.args, 1),
      })),
      dropped,
    });
  }
  enqueueAdk(controller, encoder, {
    content: { role: "model", parts },
    turnComplete: true,
    partial: false,
    finishReason: finishReason === "tool_calls" && parts.length ? "tool_calls" : "stop",
    ...(usage ? {
      usageMetadata: {
        promptTokenCount: usage.prompt_tokens || 0,
        candidatesTokenCount: usage.completion_tokens || 0,
        totalTokenCount: usage.total_tokens || 0,
      },
    } : {}),
  });
}

function normalizeToolCallArgs(call) {
  if (call.argumentsObject && typeof call.argumentsObject === "object") return call.argumentsObject;
  const parsed = parseMaybeJson(call.arguments);
  if (parsed && typeof parsed === "object") return parsed;

  const text = String(call.arguments || "").trim();
  if (!text) return {};

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const embedded = parseMaybeJson(text.slice(start, end + 1));
    if (embedded && typeof embedded === "object") return embedded;
  }

  return {};
}

function sanitizeToolCallId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function enqueueAdk(controller, encoder, frame) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
}

function installModuleFetchProbe() {
  const originalLoad = Module._load;
  if (originalLoad.__accioInjectorWrapped) return;

  Module._load = function accioInjectorModuleLoad(request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments);
    if (request === "node-fetch") return wrapNodeFetchExport(exported, "node-fetch");
    if (request === "undici" && exported?.fetch) {
      try {
        return new Proxy(exported, {
          get(target, prop, receiver) {
            if (prop === "fetch") return wrapFetchFunction(Reflect.get(target, prop, receiver), "undici.fetch");
            return Reflect.get(target, prop, receiver);
          },
        });
      } catch {}
    }
    return exported;
  };

  try {
    Object.defineProperty(Module._load, "__accioInjectorWrapped", { value: true });
  } catch {}
  networkLog("probe installed", { layer: "Module._load node-fetch/undici" });
}

function wrapNodeFetchExport(exported, label) {
  if (typeof exported === "function") return wrapFetchFunction(exported, label);
  if (exported && typeof exported === "object" && typeof exported.default === "function") {
    try {
      return { ...exported, default: wrapFetchFunction(exported.default, `${label}.default`) };
    } catch {}
  }
  return exported;
}

function installNodeHttpProbe(mod, protocol) {
  const originalRequest = mod.request;
  const originalGet = mod.get;
  if (originalRequest.__accioInjectorWrapped) return;

  mod.request = function accioInjectorRequest(input, options, callback) {
    const url = normalizeUrl(input, options);
    const method = (
      options?.method
      || input?.method
      || (typeof input === "object" && input?.method)
      || "GET"
    ).toUpperCase();
    const shouldLog = shouldLogUrl(url);
    const request = originalRequest.apply(this, arguments);

    if (!shouldLog) return request;

    const chunks = [];
    const pushChunk = (chunk) => {
      if (chunks.reduce((sum, item) => sum + item.length, 0) >= bodyPreviewLimit) return;
      try {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      } catch {}
    };

    const originalWrite = request.write;
    const originalEnd = request.end;

    request.write = function accioInjectorWrite(chunk) {
      pushChunk(chunk);
      return originalWrite.apply(this, arguments);
    };

    request.end = function accioInjectorEnd(chunk) {
      pushChunk(chunk);
      networkLog("http request", {
        layer: `${protocol}.request`,
        method,
        url,
        headers: options?.headers || input?.headers,
        bodyPreview: chunks.length ? previewBody(Buffer.concat(chunks)) : undefined,
      });
      return originalEnd.apply(this, arguments);
    };

    request.on("response", (response) => {
      networkLog("http response", {
        layer: `${protocol}.request`,
        method,
        url,
        status: response.statusCode,
        headers: response.headers,
      });
    });
    request.on("error", (error) => {
      networkLog("http error", {
        layer: `${protocol}.request`,
        method,
        url,
        error: error && error.stack || String(error),
      });
    });

    return request;
  };

  mod.get = function accioInjectorGet() {
    const request = mod.request.apply(this, arguments);
    request.end();
    return request;
  };

  try {
    Object.defineProperty(mod.request, "__accioInjectorWrapped", { value: true });
    Object.defineProperties(mod.request, Object.getOwnPropertyDescriptors(originalRequest));
    Object.defineProperties(mod.get, Object.getOwnPropertyDescriptors(originalGet));
  } catch {}
  networkLog("probe installed", { layer: `${protocol}.request` });
}

function installElectronNetProbe() {
  try {
    if (!electron.net || typeof electron.net.fetch !== "function") return;
    electron.net.fetch = wrapFetchFunction(electron.net.fetch, "electron.net.fetch");
    networkLog("probe installed", { layer: "electron.net.fetch" });
  } catch (error) {
    log("electron.net probe failed", { error: error && error.message || String(error) });
  }
}

function installNetworkProbe() {
  if (!probeConfig.enabled) {
    log("network probe disabled");
    return;
  }
  installFetchProbe();
  installModuleFetchProbe();
  installNodeHttpProbe(http, "http");
  installNodeHttpProbe(https, "https");
  installElectronNetProbe();
}

function registerPreload(session, label) {
  try {
    if (!fs.existsSync(preloadPath)) {
      log("preload missing", { preloadPath });
      return;
    }

    if (typeof session.registerPreloadScript === "function") {
      session.registerPreloadScript({
        type: "frame",
        id: "accio-injector-poc",
        filePath: preloadPath,
      });
      log("registered preload via registerPreloadScript", { label, preloadPath });
      return;
    }

    const existing = session.getPreloads();
    if (!existing.includes(preloadPath)) session.setPreloads([...existing, preloadPath]);
    log("registered preload via setPreloads", { label, preloadPath });
  } catch (error) {
    const msg = error && error.message || String(error);
    if (msg.includes("existing ID")) {
      log("preload already registered", { label, preloadPath });
      return;
    }
    log("registerPreload failed", { label, error: msg });
  }
}

log("runtime main loaded", {
  electron: process.versions.electron,
  appReady: electron.app.isReady(),
  preloadPath,
  requestProbe: {
    enabled: probeConfig.enabled,
    logAll: probeConfig.logAll,
    hosts: probeConfig.hosts,
  },
});

installNetworkProbe();

electron.ipcMain.on("accio-injector:preload-log", (_event, message) => {
  log("preload", { message: String(message) });
});

electron.app.whenReady().then(() => {
  log("app.whenReady fired");
  registerPreload(electron.session.defaultSession, "defaultSession");
});

electron.app.on("session-created", (session) => {
  registerPreload(session, "session-created");
});

electron.app.on("web-contents-created", (_event, webContents) => {
  log("web-contents-created", { id: webContents.id, type: webContents.getType() });
  webContents.on("preload-error", (_event, preload, error) => {
    log("preload-error", { preload, error: error && error.stack || String(error) });
  });
});
