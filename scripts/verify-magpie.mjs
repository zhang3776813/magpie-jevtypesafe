// 使用独立 HOME、配置、缓存及端口验证实际 Magpie；默认只请求本地模拟上游。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createSocket } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, readdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { once } from "node:events";

const pluginDir = fileURLToPath(new URL("..", import.meta.url));
const outputDir = process.env.JEV_VERIFY_OUT || path.join(pluginDir, ".verification");
const live = process.argv.includes("--live");
if (process.argv.slice(2).some(x => x !== "--live")) throw new Error("仅支持 --live；默认离线验证");
const key = live ? process.env.JEV_API_KEY?.trim() : "jv_live_isolated_test_only";
if (!key || !/^jv_live_[A-Za-z0-9_-]+$/.test(key)) throw new Error("真实验收需临时设置 JEV_API_KEY，不要写入文件");
const executable = process.env.MAGPIE_BIN || "magpie";
const clean = text => String(text).replaceAll(key, "[密钥已隐藏]");
const report = { mode: live ? "真实 JEV" : "本地模拟上游", startedAt: new Date().toISOString(), steps: [] };
const realConfig = path.join(homedir(), ".config", "magpie");
async function fingerprints() {
  const result = {};
  for (const name of ["plugins.json", "plugin-auth.json", "providers.json", "settings.json"]) {
    try { result[name] = createHash("sha256").update(await readFile(path.join(realConfig, name))).digest("hex"); }
    catch (e) { if (e.code !== "ENOENT") throw e; result[name] = null; }
  }
  return result;
}
const before = await fingerprints();
const tempRoot = await realpath(tmpdir());
const sandbox = await realpath(await mkdtemp(path.join(tempRoot, "magpie-jev-")));
const configDir = path.join(sandbox, ".config", "magpie");
let gateway;
let fixture;
let gatewayLog = "";
const seen = [];

async function cli(args, env) {
  const child = spawn(executable, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", x => { stdout += x; });
  child.stderr.on("data", x => { stderr += x; });
  const timeout = setTimeout(() => child.kill(), 45000);
  let code;
  try { [code] = await once(child, "close"); } finally { clearTimeout(timeout); }
  report.steps.push({ command: ["magpie", ...args].join(" "), exit: code, stdout: clean(stdout), stderr: clean(stderr) });
  if (code !== 0) throw new Error(clean(`Magpie 命令失败：${args.join(" ")}\n${stdout}\n${stderr}`));
  return stdout;
}
async function freePort() {
  const s = createSocket(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
try {
  await mkdir(configDir, { recursive: true });
  const port = await freePort();
  const env = { ...process.env, HOME: sandbox, USERPROFILE: sandbox,
    XDG_CONFIG_HOME: path.join(sandbox, ".config"), XDG_CACHE_HOME: path.join(sandbox, ".cache"),
    XDG_DATA_HOME: path.join(sandbox, ".local", "share"), XDG_STATE_HOME: path.join(sandbox, ".local", "state"),
    APPDATA: path.join(sandbox, "AppData", "Roaming"), LOCALAPPDATA: path.join(sandbox, "AppData", "Local"),
    CODEX_HOME: path.join(sandbox, ".codex"), CLAUDE_CONFIG_DIR: path.join(sandbox, ".claude"),
    MAGPIE_ADDR: `127.0.0.1:${port}`, NO_PROXY: "localhost,127.0.0.1,::1" };
  // 密钥只写进此次隔离的宿主鉴权文件，不传给 CLI 参数或插件源码。
  delete env.JEV_API_KEY;
  await writeFile(path.join(configDir, "plugin-auth.json"), JSON.stringify({ jevtypesafe: { type: "api", key } }), { mode: 0o600 });
  let spec = pluginDir;
  if (!live) {
    fixture = createServer(async (req, res) => {
      try {
        let raw = ""; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        const validAuth = req.headers.authorization === `Bearer ${key}`;
        seen.push({ path: req.url, validAuth, body });
        assert.equal(validAuth, true); assert.equal(req.url, "/api/v1/decide"); assert.equal(body.model, "jev");
        const answers = Object.fromEntries(Object.entries(body.questions).map(([name, q]) => [name,
          q.type === "choice" ? { type: "choice", choice: Object.keys(q.criteria)[0], confidence: 1 }
            : q.type === "score" ? { type: "score", score: 1, confidence: 1 } : { type: "noul", noul: 1 }]));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "jev-fixture", answers, usage: { input_tokens: 1, output_tokens: 0, billed_tokens: 1 } }));
      } catch (e) { res.writeHead(500); res.end(clean(e.message)); }
    });
    fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
    const fixtureURL = `http://127.0.0.1:${fixture.address().port}/api/v1/decide`;
    spec = path.join(sandbox, "fixture-plugin"); await mkdir(spec);
    const pkg = JSON.parse(await readFile(path.join(pluginDir, "package.json"), "utf8"));
    pkg.main = "./fixture.mjs";
    await writeFile(path.join(spec, "package.json"), JSON.stringify(pkg));
    // 测试专用包装：执行原始插件，仅把固定 JEV 地址改送本地模拟服务；不随插件打包。
    await writeFile(path.join(spec, "fixture.mjs"), `import { JevTypeSafePlugin } from ${JSON.stringify(pathToFileURL(path.join(pluginDir, "index.mjs")).href)};\nconst original = globalThis.fetch.bind(globalThis);\nglobalThis.fetch = (url, init) => { if (String(url) !== "https://jevtypesafe.org/api/v1/decide") throw new Error("隔离测试禁止访问其他上游"); return original(${JSON.stringify(fixtureURL)}, init); };\nexport { JevTypeSafePlugin };\n`);
  }
  await cli(["plugin", "add", spec], env);
  const listed = JSON.parse(await cli(["plugin", "--json"], env));
  assert.match(JSON.stringify(listed), /jevtypesafe/);
  report.pluginListed = true;
  gateway = spawn(executable, ["serve"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  gateway.stdout.on("data", x => { gatewayLog += x; });
  gateway.stderr.on("data", x => { gatewayLog += x; });
  gateway.on("error", e => { gatewayLog += e.message; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (gateway.exitCode !== null) throw new Error(clean(`隔离网关提前退出：${gatewayLog}`));
    try {
      const r = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer magpie" }, signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        const catalog = await r.json();
        assert.equal(catalog.data.some(x => x.id === "jevtypesafe/jev"), false, "决策模型不可出现在聊天目录");
        ready = true; break;
      }
    } catch (e) { if (e.code === "ERR_ASSERTION") throw e; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(ready, true, clean(`隔离网关未就绪：${gatewayLog}`));
  const r = await fetch(`${base}/v1/systemone`, {
    method: "POST", headers: { authorization: "Bearer magpie", "content-type": "application/json" },
    body: JSON.stringify({ model: "jevtypesafe/jev", state: "为函数添加测试", questions: {
      intent: { type: "choice", instructions: "分类", criteria: { 测试: "测试代码", 其他: "非测试" } },
      effort: { type: "score", instructions: "难度", criteria: ["低", "高"] },
      ok: { type: "noul", instructions: "是否在请求编写测试？" },
    } }), signal: AbortSignal.timeout(45000),
  });
  const raw = await r.text();
  report.decide = { status: r.status, body: clean(raw) };
  assert.equal(r.status, 200, clean(raw));
  const answer = JSON.parse(raw);
  assert.equal(typeof answer.answers.intent.choice, "string");
  assert.ok(["测试", "其他"].includes(answer.answers.intent.choice));
  assert.ok(Number.isFinite(answer.answers.effort.score));
  assert.ok(Number.isFinite(answer.answers.ok.noul));
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { authorization: "Bearer magpie", "content-type": "application/json" },
    body: JSON.stringify({ model: "jevtypesafe/jev", messages: [{ role: "user", content: "ping" }] }), signal: AbortSignal.timeout(5000),
  });
  report.chatRejected = { status: chat.status, body: clean(await chat.text()) };
  assert.equal(chat.status, 400);
  assert.match(report.chatRejected.body, /only decides/);
  if (!live) { assert.equal(seen.length, 1); report.fixtureRequests = seen; }
  report.success = true;
} catch (e) {
  report.success = false; report.error = clean(e.message); process.exitCode = 1;
} finally {
  if (gateway && gateway.exitCode === null) { const closed = once(gateway, "close"); gateway.kill(); await closed; }
  if (fixture) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
  report.realConfigUnchanged = JSON.stringify(before) === JSON.stringify(await fingerprints());
  if (!report.realConfigUnchanged) { report.success = false; report.configNote = "真实配置文件发生变化；可能有应用并发写入，不能断言保持不变"; process.exitCode = 1; }
  // 先清空鉴权及宿主产生的同名备份，再验证绝对路径范围并清理整个临时目录。
  for (const name of await readdir(configDir)) {
    if (name.startsWith("plugin-auth.json")) await writeFile(path.join(configDir, name), "{}");
  }
  const resolved = await realpath(sandbox);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith("magpie-jev-")) throw new Error("拒绝清理范围外的目录");
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  report.sandboxRemoved = true; report.finishedAt = new Date().toISOString();
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, live ? "isolated-live.json" : "isolated-mock.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}