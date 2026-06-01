const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8787);
const OUTPUT_DIR = path.join(ROOT, "output");
const MAX_BODY_SIZE = 12 * 1024 * 1024;

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = value;
  }
}

loadDotEnv();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml; charset=utf-8"
};

function apiHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Cache-Control": "no-store"
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...apiHeaders()
  });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("请求 JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

function safeStaticPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split("?")[0]);
  const relative = cleanPath === "/" ? "poster-generator.html" : cleanPath.replace(/^\/+/, "");
  const resolved = path.resolve(ROOT, relative);
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
}

function serveStatic(req, res, urlPath) {
  const filePath = safeStaticPath(urlPath);
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      res.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(content);
  });
}

function mergePrompt(prompt, negativePrompt) {
  return negativePrompt ? `${prompt}\n\nNegative constraints: ${negativePrompt}` : prompt;
}

function normalizeDoubaoSize(size) {
  if (!size || size === "auto") return "1920x1920";
  const match = String(size).match(/^(\d+)x(\d+)$/);
  if (!match) return "1920x1920";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width * height >= 3686400) return `${width}x${height}`;
  if (width > height) return "2560x1440";
  if (height > width) return "1440x2560";
  return "1920x1920";
}

function normalizeImageResult(provider, responseJson) {
  const first = responseJson && Array.isArray(responseJson.data) ? responseJson.data[0] : null;
  if (!first) {
    throw new Error(`${provider} 未返回图片数据`);
  }
  if (first.b64_json) return { imageBase64: first.b64_json };
  if (first.url) return { imageUrl: first.url };
  if (first.image_url) return { imageUrl: first.image_url };
  throw new Error(`${provider} 返回格式中没有 b64_json、url 或 image_url`);
}

async function readUpstreamJson(response, provider) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const preview = text.slice(0, 300).replace(/\s+/g, " ");
    throw new Error(`${provider} 返回了非 JSON 内容。请检查 endpoint 是否正确、模型服务是否开通、或是否被网关返回 HTML。返回片段：${preview}`);
  }
}

async function callDoubao(payload) {
  const apiKey = payload.apiKey || process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || process.env.VOLCENGINE_API_KEY;
  if (!apiKey) {
    throw new Error("缺少豆包/火山方舟 API Key。请在页面模型设置中填写，或在 .env 中设置 DOUBAO_API_KEY。");
  }

  const endpoint = payload.endpoint || process.env.DOUBAO_IMAGE_ENDPOINT || "https://ark.cn-beijing.volces.com/api/v3/images/generations";
  if (endpoint.includes("/chat/completions")) {
    throw new Error("当前 endpoint 是 /chat/completions，这是对话接口，不能生成图片。请使用 /api/v3/images/generations。");
  }

  const body = {
    model: payload.model && payload.model !== "__env__"
      ? payload.model
      : (process.env.DOUBAO_IMAGE_MODEL || "doubao-seedream-4-0-250828"),
    prompt: mergePrompt(payload.prompt, payload.negativePrompt),
    response_format: "url",
    size: normalizeDoubaoSize(payload.size)
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const json = await readUpstreamJson(response, "豆包/火山方舟");
  if (!response.ok) {
    const message = json.error && json.error.message ? json.error.message : JSON.stringify(json);
    throw new Error(`豆包生成失败：${message}`);
  }

  return {
    provider: "doubao",
    model: body.model,
    ...normalizeImageResult("豆包", json)
  };
}

async function callOpenAI(payload) {
  const apiKey = payload.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 OpenAI API Key。请在页面模型设置中填写，或在 .env 中设置 OPENAI_API_KEY。");
  }

  const body = {
    model: payload.model && payload.model !== "__env__" ? payload.model : "gpt-image-2",
    prompt: mergePrompt(payload.prompt, payload.negativePrompt),
    size: payload.size || "1024x1536",
    quality: payload.quality || "high",
    output_format: payload.outputFormat || "png"
  };

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const json = await readUpstreamJson(response, "OpenAI");
  if (!response.ok) {
    const message = json.error && json.error.message ? json.error.message : JSON.stringify(json);
    throw new Error(`OpenAI 生成失败：${message}`);
  }

  return {
    provider: "openai",
    model: body.model,
    ...normalizeImageResult("OpenAI", json)
  };
}

function saveImageIfNeeded(result, outputFormat) {
  if (!result.imageBase64) return null;
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const ext = outputFormat || "png";
  const filename = `poster-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), Buffer.from(result.imageBase64, "base64"));
  return `/output/${filename}`;
}

async function handleGenerate(req, res) {
  try {
    const payload = await readJson(req);
    if (!payload.prompt || typeof payload.prompt !== "string") {
      sendJson(res, 400, { ok: false, error: "缺少 prompt" });
      return;
    }

    const result = payload.provider === "doubao"
      ? await callDoubao(payload)
      : await callOpenAI(payload);
    const savedPath = saveImageIfNeeded(result, payload.outputFormat || "png");

    sendJson(res, 200, {
      ok: true,
      provider: result.provider,
      model: result.model,
      imageBase64: result.imageBase64,
      imageUrl: result.imageUrl || savedPath,
      savedPath,
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error.message || "生成失败",
      detail: error.cause && error.cause.message ? error.cause.message : undefined
    });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
    res.writeHead(204, apiHeaders());
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/generate-poster") {
    handleGenerate(req, res);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    sendJson(res, 404, {
      ok: false,
      error: `API route not found: ${url.pathname}`
    });
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res, url.pathname);
    return;
  }

  sendJson(res, 405, { ok: false, error: "Method not allowed" });
});

server.listen(PORT, () => {
  console.log(`Local poster proxy running at http://127.0.0.1:${PORT}/`);
  console.log("Frontend should request /api/generate-poster. The proxy will forward requests to Doubao/Volcengine.");
});
