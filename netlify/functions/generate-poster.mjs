const MIN_DOUBAO_PIXELS = 3686400;

function env(name) {
  return Netlify.env.get(name);
}

function jsonResponse(status, data) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

function normalizeImageResult(provider, responseJson) {
  const first = responseJson && Array.isArray(responseJson.data) ? responseJson.data[0] : null;
  if (!first) {
    throw new Error(`${provider} 未返回图片数据`);
  }
  if (first.b64_json) {
    return { imageBase64: first.b64_json };
  }
  if (first.url) {
    return { imageUrl: first.url };
  }
  if (first.image_url) {
    return { imageUrl: first.image_url };
  }
  throw new Error(`${provider} 返回格式中没有 b64_json 或 url`);
}

function mergePrompt(prompt, negativePrompt) {
  const guard = negativePrompt ? `\n\nNegative constraints: ${negativePrompt}` : "";
  return `${prompt}${guard}`;
}

function normalizeDoubaoSize(size) {
  if (!size || size === "auto") return "1920x1920";
  const match = String(size).match(/^(\d+)x(\d+)$/);
  if (!match) return "1920x1920";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width * height >= MIN_DOUBAO_PIXELS) return `${width}x${height}`;
  if (width > height) return "2560x1440";
  if (height > width) return "1440x2560";
  return "1920x1920";
}

async function parseJson(req) {
  try {
    return await req.json();
  } catch {
    throw new Error("JSON 解析失败");
  }
}

async function callOpenAI(payload) {
  const apiKey = payload.apiKey || env("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error("缺少 OpenAI API Key。请在页面模型设置中填写，或在 Netlify 环境变量中设置 OPENAI_API_KEY。");
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

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!response.ok) {
    const message = json.error && json.error.message ? json.error.message : text;
    throw new Error(`OpenAI 生成失败：${message}`);
  }

  return {
    provider: "openai",
    model: body.model,
    ...normalizeImageResult("OpenAI", json)
  };
}

async function callDoubao(payload) {
  const apiKey = payload.apiKey || env("DOUBAO_API_KEY") || env("ARK_API_KEY") || env("VOLCENGINE_API_KEY");
  if (!apiKey) {
    throw new Error("缺少豆包/火山方舟 API Key。请在页面模型设置中填写，或在 Netlify 环境变量中设置 DOUBAO_API_KEY/ARK_API_KEY。");
  }

  const endpoint = payload.endpoint || env("DOUBAO_IMAGE_ENDPOINT") || "https://ark.cn-beijing.volces.com/api/v3/images/generations";
  if (endpoint.includes("/chat/completions")) {
    throw new Error("当前豆包 endpoint 指向 /chat/completions，这是对话接口，不能返回图片。请改用 /api/v3/images/generations。");
  }

  const model = payload.model && payload.model !== "__env__"
    ? payload.model
    : (env("DOUBAO_IMAGE_MODEL") || "doubao-seedream-4-0-250828");

  const body = {
    model,
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

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!response.ok) {
    const message = json.error && json.error.message ? json.error.message : text;
    throw new Error(`豆包生成失败：${message}`);
  }

  return {
    provider: "doubao",
    model: body.model,
    ...normalizeImageResult("豆包", json)
  };
}

export default async (req) => {
  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const payload = await parseJson(req);
    if (!payload.prompt || typeof payload.prompt !== "string") {
      return jsonResponse(400, { ok: false, error: "缺少 prompt" });
    }

    const provider = payload.provider || "openai";
    const result = provider === "doubao"
      ? await callDoubao(payload)
      : await callOpenAI(payload);

    return jsonResponse(200, {
      ok: true,
      provider: result.provider,
      model: result.model,
      imageBase64: result.imageBase64,
      imageUrl: result.imageUrl,
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: error.message || "生成失败"
    });
  }
};

export const config = {
  path: "/api/generate-poster"
};
