import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const entry = process.env.JEV_PLUGIN_ENTRY
  ? pathToFileURL(process.env.JEV_PLUGIN_ENTRY)
  : new URL("../index.mjs", import.meta.url);
let module = {};
if (existsSync(entry)) module = await import(entry.href);
const BASE = "https://jevtypesafe.org/api/v1";
const KEY = "jv_live_offline_test_only";
const questions = { intent: { type: "choice", instructions: "分类", criteria: { 简单: null, 复杂: "多文件任务" } } };
const body = (extra = {}) => JSON.stringify({ model: "jev", state: { message: "修复测试" }, questions, ...extra });

async function hooks() {
  assert.equal(typeof module.JevTypeSafePlugin, "function", "缺少 JEV 原生决策插件实现");
  return module.JevTypeSafePlugin({});
}
async function loader(key = KEY) {
  return (await hooks()).auth.loader(async () => ({ type: "api", key }));
}
function intercept(t, result = new Response('{"answers":{}}', { headers: { "content-type": "application/json" } })) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { calls.push({ url, init }); return result; });
  return calls;
}

test("入口仅导出一个插件函数", async () => {
  await hooks();
  assert.deepEqual(Object.keys(module), ["JevTypeSafePlugin"]);
});
test("注册独立决策供应商及模型，不声明聊天和工具调用", async () => {
  const h = await hooks();
  const cfg = {};
  await h.config(cfg);
  const p = cfg.provider.jevtypesafe;
  assert.equal(p.decide, true);
  assert.equal(p.api, BASE);
  assert.equal(p.models.jev.decides, true);
  assert.equal(p.models.jev.tool_call, false);
  assert.equal(h.auth.provider, "jevtypesafe");
  assert.equal(h.auth.methods[0].type, "api");
  assert.equal(h.auth.usage, undefined, "不伪造余额接口");
});
test("重复注册保留用户已有供应商设置", async () => {
  const h = await hooks();
  const existing = { name: "自定义名称", decide: true };
  const cfg = { provider: { jevtypesafe: existing, other: { name: "别的供应商" } } };
  await h.config(cfg);
  await h.config(cfg);
  assert.equal(cfg.provider.jevtypesafe, existing);
  assert.equal(cfg.provider.other.name, "别的供应商");
});
for (const auth of [undefined, { type: "oauth", access: "x" }, { type: "api", key: "" }, { type: "api", key: "sk-other" }, { type: "api", key: "jv_live_a\nb" }, { type: "api", key: 3 }]) {
  test(`拒绝无效鉴权：${JSON.stringify(auth)}`, async () => {
    const h = await hooks();
    await assert.rejects(() => h.auth.loader(async () => auth), /密钥|登录/);
  });
}
test("固定目标地址、路径及模型映射；只发送必要鉴权头", async (t) => {
  const response = new Response(JSON.stringify({ model: "jev-1.14.0", answers: {}, usage: { billed_tokens: 20, remaining_tokens: 200 } }), { headers: { "content-type": "application/json", "x-request-id": "test" } });
  const calls = intercept(t, response);
  const l = await loader(` ${KEY} `);
  assert.equal(l.baseURL, BASE);
  const result = await l.fetch(`${BASE}/systemone`, { method: "POST", headers: { authorization: "Bearer wrong", cookie: "private", "x-magpie-work-dir": "private", "x-api-key": "wrong" }, body: body({ model: "jev-1.14.0", stream: true }) });
  assert.equal(result, response);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, `${BASE}/decide`);
  assert.deepEqual(JSON.parse(init.body), { model: "jev", state: { message: "修复测试" }, questions });
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("cookie"), null);
  assert.equal(headers.get("x-magpie-work-dir"), null);
  assert.equal(headers.get("x-api-key"), null);
  assert.equal(init.redirect, "error", "不能将密钥转发到重定向地址");
  assert.equal(init.method, "POST");
});
test("支持标准 Request 输入且保留取消信号", async (t) => {
  const calls = intercept(t);
  const abort = new AbortController();
  const req = new Request(`${BASE}/systemone`, { method: "POST", body: body(), signal: abort.signal });
  await (await loader()).fetch(req);
  abort.abort();
  assert.equal(calls[0].init.signal.aborted, true);
});
test("已经取消的请求不发送到上游", async (t) => {
  const calls = intercept(t);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(() => loader().then(l => l.fetch(`${BASE}/systemone`, { method: "POST", body: body(), signal: abort.signal })), { name: "AbortError" });
  assert.equal(calls.length, 0);
});
for (const url of ["https://other.example/systemone", `${BASE}/decide`, `${BASE}/systemone?key=x`, "not a URL"]) {
  test(`拒绝非宿主决策地址：${url}`, async (t) => {
    const calls = intercept(t);
    const r = await (await loader()).fetch(url, { method: "POST", body: body() });
    assert.ok([400, 404].includes(r.status));
    assert.equal(calls.length, 0);
  });
}
test("拒绝 GET，明确要求 POST", async (t) => {
  const calls = intercept(t);
  const r = await (await loader()).fetch(`${BASE}/systemone`);
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "POST");
  assert.equal(calls.length, 0);
});
for (const [name, raw] of [
  ["无效 JSON", "{"], ["空请求体", "null"], ["数组请求体", "[]"],
  ["缺少 state", JSON.stringify({ model: "jev", questions })],
  ["空 state", body({ state: null })], ["数值 state", body({ state: 7 })],
  ["空问题", body({ questions: {} })], ["数组问题", body({ questions: [] })],
  ["缺少问题", body({ questions: null })], ["未知模型", body({ model: "openai-decisions" })],
  ["图片不在首版范围", body({ assets: {} })],
  ["未知问题类型", body({ questions: { q: { type: "box", instructions: "找对象" } } })],
  ["空问题对象", body({ questions: { q: null } })],
  ["缺少指令", body({ questions: { q: { type: "noul" } } })],
  ["空指令", body({ questions: { q: { type: "noul", instructions: null } } })],
  ["超长 state", body({ state: "x".repeat(7999) })],
]) {
  test(`输入校验：${name}`, async (t) => {
    const calls = intercept(t);
    const r = await (await loader()).fetch(`${BASE}/systemone`, { method: "POST", body: raw });
    assert.equal(r.status, 400);
    const text = await r.text();
    assert.equal(text.includes(KEY), false);
    assert.equal(typeof JSON.parse(text).error.message, "string");
    assert.equal(calls.length, 0);
  });
}
for (const state of ["", "x".repeat(7998), ["文本", { value: 1 }]]) {
  test(`允许合法 state：序列化长度 ${JSON.stringify(state).length}`, async (t) => {
    const calls = intercept(t);
    const r = await (await loader()).fetch(`${BASE}/systemone`, { method: "POST", body: body({ state }) });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(calls[0].init.body).state, state);
  });
}
test("choice、score、noul 和结构化指令保持原样", async (t) => {
  const calls = intercept(t);
  const qs = { ...questions, effort: { type: "score", instructions: { text: "评估难度" }, criteria: ["低", "高"] }, levels: { type: "noul", instructions: ["是否", "分级"] } };
  await (await loader()).fetch(`${BASE}/systemone`, { method: "POST", body: body({ questions: qs }) });
  assert.deepEqual(JSON.parse(calls[0].init.body).questions, qs);
});
for (const status of [401, 402, 429, 500]) {
  test(`保留上游 ${status} 状态、响应体和重试头`, async (t) => {
    const r = new Response('{"error":"上游测试错误"}', { status, headers: { "retry-after": "60", "content-type": "application/json" } });
    const calls = intercept(t, r);
    const out = await (await loader()).fetch(`${BASE}/systemone`, { method: "POST", body: body() });
    assert.equal(out, r);
    assert.equal(out.headers.get("retry-after"), "60");
    assert.equal(await out.text(), '{"error":"上游测试错误"}');
    assert.equal(calls.length, 1, "插件不自动重试消耗额度");
  });
}
test("上游网络异常交回宿主处理，不吞掉异常或重试", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new TypeError("离线网络错误"); });
  await assert.rejects(() => loader().then(l => l.fetch(`${BASE}/systemone`, { method: "POST", body: body() })), /离线网络错误/);
  assert.equal(calls, 1);
});