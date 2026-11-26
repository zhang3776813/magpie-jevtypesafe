// Magpie 原生决策插件：只适配托管 JEV，不模拟聊天或自动改用其他付费模型。
const PROVIDER = "jevtypesafe";
const BASE = "https://jevtypesafe.org/api/v1";
const ENDPOINT = `${BASE}/decide`;

function invalid(message, status = 400) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (status === 405) headers.allow = "POST";
  return new Response(JSON.stringify({ error: { type: "invalid_request_error", message } }), { status, headers });
}

function checkBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "请求体必须为 JSON 对象";
  if (body.model !== "jev" && body.model !== "jev-1.14.0") return "此插件仅支持 JEV 决策模型";
  if (body.state === null || !["string", "object"].includes(typeof body.state)) return "state 必须为字符串、对象或数组";
  if (JSON.stringify(body.state).length > 8000) return "state 序列化后超过 8,000 字符，请缩短上下文；插件未自动截断";
  if (Object.hasOwn(body, "assets")) return "首版仅支持文本决策，不支持图片 assets 或 box";
  const qs = body.questions;
  if (!qs || typeof qs !== "object" || Array.isArray(qs) || Object.keys(qs).length === 0) return "questions 必须为非空问题对象";
  for (const q of Object.values(qs)) {
    if (!q || typeof q !== "object" || Array.isArray(q) || !["choice", "score", "noul"].includes(q.type)) return "问题类型仅支持 choice、score、noul";
    if (q.instructions === null || !["string", "object"].includes(typeof q.instructions)) return "每个问题必须提供字符串或结构化 JSON instructions";
  }
  // criteria 等细节由上游按实际版本校验，不重新解释或删改问题内容。
  return null;
}

export const JevTypeSafePlugin = async () => ({
  async config(cfg) {
    cfg.provider ??= {};
    cfg.provider[PROVIDER] ??= {
      name: "JEV 托管决策",
      npm: "@ai-sdk/openai-compatible",
      api: BASE,
      decide: true,
      models: {
        jev: {
          name: "JEV（托管决策，非聊天模型）",
          decides: true,
          tool_call: false,
          reasoning: false,
          modalities: { input: ["text"] },
        },
      },
    };
  },
  auth: {
    provider: PROVIDER,
    methods: [{ type: "api", label: "JEV 托管服务 API 密钥", placeholder: "jv_live_…" }],
    async loader(getAuth) {
      const auth = await getAuth();
      const key = typeof auth?.key === "string" ? auth.key.trim() : "";
      if (auth?.type !== "api" || !/^jv_live_[A-Za-z0-9_-]+$/.test(key)) {
        throw new Error("请先使用 jv_live_ 开头的 JEV API 密钥登录此供应商");
      }
      return {
        baseURL: BASE,
        apiKey: key,
        async fetch(input, init) {
          let request;
          try {
            request = new Request(input, init);
          } catch {
            return invalid("无法读取宿主决策请求");
          }
          if (request.url !== `${BASE}/systemone`) return invalid("仅接受此供应商的 /systemone 决策请求", 404);
          if (request.method !== "POST") return invalid("决策请求必须使用 POST", 405);
          request.signal.throwIfAborted();
          let body;
          try {
            body = await request.json();
          } catch {
            request.signal.throwIfAborted();
            return invalid("请求体不是有效的 JSON");
          }
          const error = checkBody(body);
          if (error) return invalid(error);
          // 不复制 Cookie、宿主内部头或其他供应商的鉴权；禁止重定向携带密钥。
          return globalThis.fetch(ENDPOINT, {
            method: "POST",
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({ model: "jev", state: body.state, questions: body.questions }),
            signal: request.signal,
            redirect: "error",
          });
        },
      };
    },
  },
});