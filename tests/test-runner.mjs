/**
 * tests/test-runner.mjs
 * 本地模拟 EdgeOne Cloud Functions 环境，自动化端到端测试
 */
import { onRequest } from "../cloud-functions/[[default]].js";

const env = {
  ENCRYPTION_KEY: "test-encryption-key-32bytes-secret-rand",
  SESSION_SECRET: "test-session-key-32bytes-secret-rand",
  USE_MEMORY_STORE: "1",
};

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    failed++;
    throw new Error(message);
  } else {
    console.log(`✅ PASS: ${message}`);
    passed++;
  }
}

async function request(path, options = {}) {
  const url = `http://localhost${path}`;
  const req = new Request(url, {
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return await onRequest({ request: req, env });
}

console.log("=== EdgeRelay (EdgeOne Pages + Blob) 自动化回归测试 ===\n");

// 1. 健康检查
{
  const res = await request("/health");
  assert(res.status === 200, "健康检查 HTTP 200");
  const data = await res.json();
  assert(data.status === "ok", "健康检查状态为 ok");
  assert(data.storage === "edgeone-blob", "存储驱动标识为 edgeone-blob");
}

// 2. 静态资产与 SPA Fallback
{
  const resHome = await request("/");
  assert(resHome.status === 200, "首页根路由 HTTP 200");
  const html = await resHome.text();
  assert(/<title>[^<]*Relay[^<]*<\/title>/.test(html), "首页成功注入动态 SEO 标题");

  const assetMatch = html.match(/src="\/assets\/(index-[^"]+\.js)"/);
  assert(!!assetMatch, "首页包含入口 JS 资产");
  const resAsset = await request(`/assets/${assetMatch[1]}`);
  assert(resAsset.status === 200, "静态 JS 资产 HTTP 200");
  assert(resAsset.headers.get("content-type")?.includes("javascript"), "静态资产 Content-Type 正确");
}

// 3. 用户注册与第一位管理员自举
let adminCookie = "";
let adminUserId = "";
{
  const regRes = await request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: {
      email: "admin@edgerelay.test",
      password: "StrongPassword123!",
      tosAccepted: true,
      privacyAccepted: true,
    },
  });
  assert(regRes.status === 200 || regRes.status === 201, "第一位管理员注册 HTTP 200/201");
  const regData = await regRes.json();
  adminUserId = regData.id;

  const setCookie = regRes.headers.get("set-cookie") || "";
  assert(setCookie.includes("gw_session="), "注册成功颁发 gw_session Cookie");
  adminCookie = setCookie.split(";")[0];

  const bootstrapMe = await request("/api/auth/me", { headers: { cookie: adminCookie } });
  const bootstrapData = await bootstrapMe.json();
  assert(bootstrapData.user.role === "superadmin", "首位注册用户自动提权为 superadmin 角色");
}

// 4. 用户登录
{
  const loginRes = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: {
      email: "admin@edgerelay.test",
      password: "StrongPassword123!",
    },
  });
  assert(loginRes.status === 200, "用户登录 HTTP 200");
  const loginData = await loginRes.json();
  assert(loginData.email === "admin@edgerelay.test", "登录成功返回正确邮箱");
}

// 5. 查询个人信息与余额
{
  const meRes = await request("/api/auth/me", {
    headers: { cookie: adminCookie },
  });
  assert(meRes.status === 200, "查询个人信息 HTTP 200");
  const meData = await meRes.json();
  assert(meData.user.role === "superadmin", "身份正确识别为 superadmin");
  assert(typeof meData.balance.available === "number", "钱包余额字段存在且合法");
}

// 6. 创建 API Key
let apiKeyPlaintext = "";
let apiKeyId = "";
{
  const keyRes = await request("/api/keys", {
    method: "POST",
    headers: {
      cookie: adminCookie,
      "content-type": "application/json",
    },
    body: {
      name: "开发测试 Key",
      quotaUsd: 50.0,
    },
  });
  assert(keyRes.status === 200 || keyRes.status === 201, "创建 API Key HTTP 200/201");
  const keyData = await keyRes.json();
  assert(String(keyData.key).startsWith("sk-gw-"), "成功生成 sk-gw- 格式 API Key");
  apiKeyPlaintext = keyData.key;
  apiKeyId = keyData.id;

  // 验证 Key 列表
  const listRes = await request("/api/keys", {
    headers: { cookie: adminCookie },
  });
  const listData = await listRes.json();
  assert(listData.keys.some((k) => k.id === apiKeyId), "用户 Key 列表中成功列出新建 Key");
}

// 7. 模型列表接口
{
  const modelsRes = await request("/v1/models", {
    headers: { authorization: `Bearer ${apiKeyPlaintext}` },
  });
  assert(modelsRes.status === 200, "查询 /v1/models HTTP 200");
  const modelsData = await modelsRes.json();
  assert(Array.isArray(modelsData.data), "模型列表格式符合 OpenAI 规范");
  const modelIds = modelsData.data.map((m) => m.id);
  assert(modelIds.length > 0, "成功加载引导数据中的可用模型");
  assert(modelIds.every((id) => typeof id === "string" && id.length > 0), "模型 ID 均为非空字符串");
}

// 8. 管理员二次验证与操作
{
  // step-up 验证
  const stepRes = await request("/api/auth/stepup", {
    method: "POST",
    headers: {
      cookie: adminCookie,
      "content-type": "application/json",
    },
    body: { password: "StrongPassword123!" },
  });
  assert(stepRes.status === 200, "管理员二次验证 Step-up HTTP 200");

  // 管理操作：为用户充值 100 元
  const topupRes = await request("/api/admin/actions", {
    method: "POST",
    headers: {
      cookie: adminCookie,
      "content-type": "application/json",
    },
    body: {
      action: "topup",
      payload: { scope: `user:${adminUserId}`, amount: 100 },
    },
  });
  assert(topupRes.status === 200, "管理员充值 action HTTP 200");

  // 验证余额变动
  const meRes = await request("/api/auth/me", { headers: { cookie: adminCookie } });
  const meData = await meRes.json();
  assert(meData.balance.available >= 100, "用户钱包充值到账成功");

  // 验证防篡改审计链
  const auditRes = await request("/api/admin/actions", {
    method: "POST",
    headers: {
      cookie: adminCookie,
      "content-type": "application/json",
    },
    body: { action: "verify_audit_chain" },
  });
  assert(auditRes.status === 200, "审计链校验请求 HTTP 200");
  const auditData = await auditRes.json();
  assert(auditData.result.ok === true, "防篡改哈希链（SHA-256 Chain）完整性校验通过");
}

// 8.1 审计日志删除与清空（删除后自动重建哈希链）
{
  const action = (name, payload = {}) => request("/api/admin/actions", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: { action: name, payload },
  });

  const listData = await (await action("list_audit", { limit: 50 })).json();
  assert(Array.isArray(listData.logs) && listData.logs.length > 0, "审计日志列表返回记录");
  const target = listData.logs.find((l) => l.action === "admin.topup") ?? listData.logs[0];

  const delRes = await action("delete_audit_log", { id: target.id });
  assert(delRes.status === 200, "删除单条审计日志 HTTP 200");
  const afterDel = await (await action("list_audit", { limit: 50 })).json();
  assert(!afterDel.logs.some((l) => l.id === target.id), "目标审计日志已删除");

  const verifyAfterDel = await (await action("verify_audit_chain")).json();
  assert(verifyAfterDel.result.ok === true, "删除后哈希链自动重建并校验通过");

  const clearRes = await action("clear_audit_logs");
  assert(clearRes.status === 200, "清空审计日志 HTTP 200");
  const afterClear = await (await action("list_audit", { limit: 50 })).json();
  assert(afterClear.logs.length === 1 && afterClear.logs[0].action === "admin.clear_audit_logs", "清空后仅保留本次清空操作的审计记录");

  const verifyAfterClear = await (await action("verify_audit_chain")).json();
  assert(verifyAfterClear.result.ok === true, "清空后哈希链从 GENESIS 重新校验通过");
}

// 8.2 对话转发链路（模拟上游，覆盖流式 tee 透传 / 旁路记账 / 用量潮写）
{
  const http = await import("node:http");
  let lastUpstreamBody = {};
  const upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      lastUpstreamBody = body;
      // 模拟 AMD：显式拒绝 thinking 参数，复现线上 400
      if (body.model === "amd-upstream-model" && body.thinking !== undefined) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: '"thinking" is not supported on /v1/chat/completions', type: "invalid_request", code: "unsupported_parameter" } }));
        return;
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", choices: [{ index: 0, delta: { content: "你好，" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", choices: [{ index: 0, delta: { content: "世界" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = upstream.address().port;

  try {
    const action = (name, payload = {}) => request("/api/admin/actions", {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: { action: name, payload },
    });

    const provRes = await action("upsert_provider", {
      name: "MockUpstream",
      slug: "mockupstream",
      kind: "openai_compat",
      baseUrl: `http://127.0.0.1:${port}`,
      authScheme: "bearer",
      key: "mock-upstream-key",
    });
    assert(provRes.status === 200, "创建模拟上游渠道 HTTP 200");
    const provData = await provRes.json();

    // 凭据重复提交防护：连点「保存凭据」、并发双击、同批重复粘贴都不应产生重复记录
    const reSubmit = await action("upsert_provider_key", {
      providerId: provData.result.id,
      key: "mock-upstream-key",
      label: "prod",
    });
    const reSubmitData = await reSubmit.json();
    assert(reSubmitData.result?.count === 0 && reSubmitData.result?.skipped === 1, "重复提交同一 Key 被幂等拦截（0 新增 / 1 跳过）");

    const dupKey = "mock-upstream-key-2";
    const [concurrentA, concurrentB] = await Promise.all([
      action("upsert_provider_key", { providerId: provData.result.id, key: dupKey, label: "prod" }),
      action("upsert_provider_key", { providerId: provData.result.id, key: dupKey, label: "prod" }),
    ]);
    const concurrentAData = await concurrentA.json();
    const concurrentBData = await concurrentB.json();
    const insertedByDoubleClick = (concurrentAData.result?.count || 0) + (concurrentBData.result?.count || 0);
    assert(insertedByDoubleClick === 1, `并发双击同一 Key 只落一条（实际 ${insertedByDoubleClick} 条）`);

    const batchRes = await action("upsert_provider_key", {
      providerId: provData.result.id,
      keys: ["mock-key-batch", "mock-key-batch", "mock-key-batch-2"],
      label: "batch",
    });
    const batchData = await batchRes.json();
    assert(batchData.result?.count === 2 && batchData.result?.skipped === 1, "同批粘贴重复 Key 自动去重（2 新增 / 1 跳过）");

    const listAfterKeys = await (await action("list_providers")).json();
    const provAfterKeys = listAfterKeys.providers.find((x) => x.id === provData.result.id);
    assert(provAfterKeys?.key_count === 4, `渠道 Key 总数正确（期望 4，实际 ${provAfterKeys?.key_count}）`);

    const modelRes = await action("upsert_model", {
      publicName: "mock-model",
      providerId: provData.result.id,
      upstreamModel: "mock-upstream-model",
      inputPerMillion: 0,
      outputPerMillion: 0,
    });
    assert(modelRes.status === 200, "创建模拟模型映射 HTTP 200");

    // 非流式
    const nonStream = await request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: { model: "mock-model", messages: [{ role: "user", content: "ping" }], stream: false },
    });
    assert(nonStream.status === 200, "非流式对话 HTTP 200");
    const nonStreamData = await nonStream.json();
    assert(nonStreamData.choices?.[0]?.message?.content === "pong", "非流式对话内容与上游一致");

    // 流式：确认 tee 透传后客户端能拿到完整 SSE
    const streamRes = await request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: { model: "mock-model", messages: [{ role: "user", content: "ping" }], stream: true },
    });
    assert(streamRes.status === 200, "流式对话 HTTP 200");
    assert((streamRes.headers.get("content-type") || "").includes("text/event-stream"), "流式响应 Content-Type 正确");
    const streamText = await streamRes.text();
    assert(streamText.includes("你好，") && streamText.includes("世界"), "流式响应完整透传上游增量内容");
    assert(streamText.trimEnd().endsWith("data: [DONE]"), "流式响应以 [DONE] 正常收尾");

    // 并发请求：确认内存限流与缓存无竞态
    const parallel = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request("/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
          body: { model: "mock-model", messages: [{ role: "user", content: `p${i}` }], stream: false },
        })
      )
    );
    assert(parallel.every((r) => r.status === 200), "8 路并发对话全部 HTTP 200");

    // 等待写后置潮写落库后核对用量统计
    await new Promise((r) => setTimeout(r, 1200));
    const logsData = await (await request("/api/admin/usage/logs?limit=20", { headers: { cookie: adminCookie } })).json();
    const mockLogs = (logsData.logs || []).filter((l) => l.public_model === "mock-model");
    assert(mockLogs.length >= 10, `用量日志已记录模拟模型调用（${mockLogs.length} 条）`);
    assert(mockLogs.some((l) => l.status === "success" && l.prompt_tokens === 7 && l.completion_tokens === 5), "流式 usage 统计正确计入（7/5 tokens）");

    // 操练场：使用账户自有 Key，并与 /v1 共用同一套 usage_logs
    const pgRes = await request("/api/playground/chat", {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json", "x-request-id": "pg-test-req-1" },
      body: { model: "mock-model", messages: [{ role: "user", content: "ping" }], stream: false, key_id: apiKeyId },
    });
    assert(pgRes.status === 200, "操练场对话 HTTP 200（使用账户自有 Key）");
    const pgData = await pgRes.json();
    assert(pgData.choices?.[0]?.message?.content === "pong", "操练场对话内容与上游一致");

    const foreign = await request("/api/playground/chat", {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: { model: "mock-model", messages: [{ role: "user", content: "ping" }], stream: false, key_id: "not-a-real-key" },
    });
    assert(foreign.status === 403, `操练场拒绝非当前账户的 Key（实际 ${foreign.status}）`);

    let pgLog = null;
    for (let i = 0; i < 10 && !pgLog; i++) {
      const after = await (await request("/api/admin/usage/logs?limit=50", { headers: { cookie: adminCookie } })).json();
      pgLog = (after.logs || []).find((l) => l.request_id === "pg-test-req-1");
      if (!pgLog) await new Promise((r) => setTimeout(r, 200));
    }
    assert(!!pgLog, "操练场调用产生 usage_logs 记录");
    assert(pgLog.status === "success" && pgLog.api_key_id === apiKeyId, "操练场 usage_logs 归属当前账户的 Key 且状态 success");
    assert(pgLog.prompt_tokens === 3 && pgLog.completion_tokens === 1, "操练场 usage_logs 记录上游 token 用量");

    // AMD 渠道参数适配：thinking 不能透传，需映射为 reasoning_effort
    const amdProv = await action("upsert_provider", {
      name: "AMD-Test",
      slug: "amd",
      kind: "openai_compat",
      baseUrl: `http://127.0.0.1:${port}`,
      authScheme: "bearer",
      key: "mock-amd-key",
    });
    assert(amdProv.status === 200, "创建 AMD 测试渠道 HTTP 200");
    const amdProvData = await amdProv.json();
    const amdModel = await action("upsert_model", {
      publicName: "amd-model",
      providerId: amdProvData.result.id,
      upstreamModel: "amd-upstream-model",
      inputPerMillion: 0,
      outputPerMillion: 0,
    });
    assert(amdModel.status === 200, "创建 AMD 测试模型映射 HTTP 200");

    const amdTrue = await request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: { model: "amd-model", messages: [{ role: "user", content: "ping" }], stream: false, thinking: true },
    });
    assert(amdTrue.status === 200, `AMD 渠道带 thinking=true 不再 400（实际 ${amdTrue.status}）`);
    assert(!("thinking" in lastUpstreamBody), "AMD 上游请求体已剔除 thinking");
    assert(lastUpstreamBody.reasoning_effort === "medium", "thinking=true 映射为 reasoning_effort=medium");

    const amdHigh = await request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: { model: "amd-model", messages: [{ role: "user", content: "ping" }], stream: false, thinking: "high" },
    });
    assert(amdHigh.status === 200 && lastUpstreamBody.reasoning_effort === "high", "thinking=high 映射为 reasoning_effort=high");

    const amdOff = await request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: { model: "amd-model", messages: [{ role: "user", content: "ping" }], stream: false, thinking: { type: "disabled" } },
    });
    assert(amdOff.status === 200 && !("thinking" in lastUpstreamBody) && !("reasoning_effort" in lastUpstreamBody), "thinking 关闭态丢弃且不注入 reasoning_effort");

    // 非 AMD 渠道行为未变：thinking 原样透传
    const other = await request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: { model: "mock-model", messages: [{ role: "user", content: "ping" }], stream: false, thinking: true },
    });
    assert(other.status === 200 && lastUpstreamBody.thinking === true, "非 AMD 渠道 thinking 参数行为未变");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
}

// 9. 超级管理员仪表盘回归：superadmin 必须能读取管理员用量接口
{
  const regRes = await request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: {
      email: "hackerxiaow@gmail.com",
      password: "StrongPassword123!",
      tosAccepted: true,
      privacyAccepted: true,
    },
  });
  assert(regRes.status === 200 || regRes.status === 201, "创始人账号注册 HTTP 200/201");
  const suCookie = (regRes.headers.get("set-cookie") || "").split(";")[0];
  assert(suCookie.includes("gw_session="), "创始人账号颁发 gw_session Cookie");

  const statsRes = await request("/api/admin/stats", { headers: { cookie: suCookie } });
  assert(statsRes.status === 200, "superadmin 读取 /api/admin/stats HTTP 200");

  const trendRes = await request("/api/admin/usage/trend?days=7", { headers: { cookie: suCookie } });
  assert(trendRes.status === 200, "superadmin 读取 /api/admin/usage/trend HTTP 200");
  const trendData = await trendRes.json();
  assert(Array.isArray(trendData.points) && trendData.points.length === 7, "趋势接口返回 7 个数据点");

  const logsRes = await request("/api/admin/usage/logs?limit=10", { headers: { cookie: suCookie } });
  assert(logsRes.status === 200, "superadmin 读取 /api/admin/usage/logs HTTP 200");
  const logsData = await logsRes.json();
  assert(Array.isArray(logsData.logs), "用量日志接口返回 logs 数组");
}

// 10. 全站备份 / 导入 / 站内快照
{
  const jsonHeaders = { cookie: adminCookie, "content-type": "application/json" };

  // 10.1 先写入一个可校验的昵称
  const setBefore = await request("/api/user/profile", {
    method: "PATCH",
    headers: jsonHeaders,
    body: { nickname: "备份前昵称", bio: "backup-test" },
  });
  assert(setBefore.status === 200, "写入备份前昵称 HTTP 200");

  // 10.2 导出备份
  const exportRes = await request("/api/admin/backup/export", { headers: { cookie: adminCookie } });
  assert(exportRes.status === 200, "导出全站备份 HTTP 200");
  assert((exportRes.headers.get("content-disposition") || "").includes("edgerelay-backup-"), "导出响应带备份文件名");
  const backup = await exportRes.json();
  assert(backup.format === "edgerelay-backup" && backup.version === 1, "备份格式标识正确");
  assert(Array.isArray(backup.entries) && backup.entries.length > 0, "备份包含业务数据条目");
  assert(!backup.entries.some((entry) => entry.key.startsWith("session:")), "备份不包含登录会话");
  assert(!backup.entries.some((entry) => entry.key.startsWith("backup:")), "备份不包含站内快照自身");
  assert(!backup.entries.some((entry) => entry.key.startsWith("kv/")), "备份不包含验证码/限流等瞬时状态");

  // 10.3 修改数据后导入，验证恢复
  const setAfter = await request("/api/user/profile", {
    method: "PATCH",
    headers: jsonHeaders,
    body: { nickname: "备份后昵称" },
  });
  assert(setAfter.status === 200, "写入备份后昵称 HTTP 200");

  const importRes = await request("/api/admin/backup/import", {
    method: "POST",
    headers: jsonHeaders,
    body: backup,
  });
  assert(importRes.status === 200, "导入全站备份 HTTP 200");
  const importData = await importRes.json();
  assert(importData.ok === true && importData.summary.entries > 0, "导入返回恢复条目统计");

  const meAfterImport = await (await request("/api/auth/me", { headers: { cookie: adminCookie } })).json();
  assert(meAfterImport.nickname === "备份前昵称", "导入后昵称恢复到备份时状态");
  assert(meAfterImport.user.role === "superadmin", "导入后当前管理员会话仍然有效");

  // 10.4 生成 / 列出 / 恢复 / 删除站内快照
  const snapRes = await request("/api/admin/backup/snapshot", { method: "POST", headers: jsonHeaders, body: {} });
  assert(snapRes.status === 200, "生成站内快照 HTTP 200");
  const snapshot = (await snapRes.json()).snapshot;
  assert(snapshot && typeof snapshot.id === "string" && snapshot.entries > 0, "快照返回有效元数据");

  const listRes = await request("/api/admin/backup/list", { headers: { cookie: adminCookie } });
  const listData = await listRes.json();
  assert(Array.isArray(listData.snapshots) && listData.snapshots.some((item) => item.id === snapshot.id), "快照列表包含新生成的快照");

  const restoreRes = await request("/api/admin/backup/restore", {
    method: "POST",
    headers: jsonHeaders,
    body: { id: snapshot.id },
  });
  assert(restoreRes.status === 200, "恢复站内快照 HTTP 200");

  const deleteRes = await request("/api/admin/backup/delete", {
    method: "POST",
    headers: jsonHeaders,
    body: { id: snapshot.id },
  });
  assert(deleteRes.status === 200, "删除站内快照 HTTP 200");

  const listAfter = await (await request("/api/admin/backup/list", { headers: { cookie: adminCookie } })).json();
  assert(!listAfter.snapshots.some((item) => item.id === snapshot.id), "删除后快照不再出现在列表");
}

// 11. Telegram 机器人备份
{
  const jsonHeaders = { cookie: adminCookie, "content-type": "application/json" };
  const testToken = "123456789:AA_test_token_abcdefghijklmnopqrstuvwxyz";

  // 11.1 保存配置（Token 加密落盘，接口只回掩码）
  const saveRes = await request("/api/admin/backup/telegram", {
    method: "POST",
    headers: jsonHeaders,
    body: { botToken: testToken, chatId: "-1001234567890" },
  });
  assert(saveRes.status === 200, "保存 Telegram 配置 HTTP 200");
  const saveData = await saveRes.json();
  assert(saveData.status.configured === true, "Telegram 配置状态为已配置");
  assert(saveData.status.botTokenMasked && !saveData.status.botTokenMasked.includes("AA_test_token"), "Telegram Bot Token 仅返回掩码");

  // 11.2 读取配置状态
  const statusRes = await request("/api/admin/backup/telegram", { headers: { cookie: adminCookie } });
  assert(statusRes.status === 200, "读取 Telegram 配置 HTTP 200");
  const statusData = await statusRes.json();
  assert(statusData.configured === true && statusData.chatId === "-1001234567890", "Telegram Chat ID 持久化正确");

  // 11.3 全站备份不包含 Telegram 配置（backup: 前缀）
  const exportRes = await request("/api/admin/backup/export", { headers: { cookie: adminCookie } });
  const exportData = await exportRes.json();
  assert(!exportData.entries.some((entry) => entry.key === "backup:telegram"), "全站备份不包含 Telegram Bot Token");

  // 11.4 测试消息与推送备份（拦截 Telegram 网络请求）
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const testRes = await request("/api/admin/backup/telegram/test", {
      method: "POST",
      headers: jsonHeaders,
      body: {},
    });
    assert(testRes.status === 200, "发送 Telegram 测试消息 HTTP 200");
    assert(calls.some((call) => call.url.includes("/sendMessage")), "测试消息调用 Telegram sendMessage");

    const pushRes = await request("/api/admin/backup/telegram/push", {
      method: "POST",
      headers: jsonHeaders,
      body: {},
    });
    assert(pushRes.status === 200, "推送备份到 Telegram HTTP 200");
    const pushCall = calls.find((call) => call.url.includes("/sendDocument"));
    assert(!!pushCall, "推送备份调用 Telegram sendDocument");
    assert(pushCall.init.body instanceof FormData, "推送内容为 multipart FormData 文件");
  } finally {
    globalThis.fetch = realFetch;
  }

  // 11.5 清除配置
  const clearRes = await request("/api/admin/backup/telegram/clear", {
    method: "POST",
    headers: jsonHeaders,
    body: {},
  });
  assert(clearRes.status === 200, "清除 Telegram 配置 HTTP 200");
  const statusAfter = await (await request("/api/admin/backup/telegram", { headers: { cookie: adminCookie } })).json();
  assert(statusAfter.configured === false, "清除后 Telegram 配置状态为未配置");
}

// 12. 在线支付（易支付协议）
{
  const crypto = await import("node:crypto");
  const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
  /** 与后端 buildEpaySign 同算法：过滤 sign/sign_type 与空值 → 升序 → k=v& → 末尾接 KEY */
  const epaySign = (params, key) =>
    md5(
      Object.keys(params)
        .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "")
        .sort()
        .map((k) => `${k}=${params[k]}`)
        .join("&") + key
    );

  const PAY_KEY = "EPAYkey1234567890abcdefghijklmnop";
  const headers = { "content-type": "application/json", cookie: adminCookie };

  // 12.1 写入支付配置（易支付的写操作需要二次验证，这里带上管理员密码）
  const setRes = await request("/api/admin/actions", {
    method: "POST",
    headers,
    body: {
      action: "set_epay",
      payload: {
        enabled: true,
        gateway: "https://epay-pages.pages.dev",
        pid: "1001",
        key: PAY_KEY,
        channels: ["alipay", "wxpay"],
        minAmount: 1,
        maxAmount: 1000,
        productName: "API 额度充值",
        password: "StrongPassword123!",
      },
    },
  });
  assert(setRes.status === 200, "保存易支付配置 HTTP 200");

  const gotRes = await request("/api/admin/actions", {
    method: "POST",
    headers,
    body: { action: "get_epay", payload: {} },
  });
  const got = await gotRes.json();
  assert(got.epay?.pid === "1001", "支付配置 PID 回读正确");
  assert(got.epay?.hasKey === true, "商户密钥已加密入库（仅返回 hasKey）");
  assert(!JSON.stringify(got).includes(PAY_KEY), "接口不回显商户密钥明文");

  // 12.2 下单：拦截上游 mapi.php
  const realFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ code: 1, trade_no: "T20261104001", payurl: "https://pay.example/x", qrcode: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const createRes = await request("/api/pay/epay/create", {
      method: "POST",
      headers,
      body: { amount: 10, type: "alipay" },
    });
    assert(createRes.status === 200, "创建支付订单 HTTP 200");
    const created = await createRes.json();
    assert(!!created.outTradeNo, "返回商户订单号");
    assert(created.payUrl === "https://pay.example/x", "透传平台收银台地址");
    assert(created.amount === 10, "订单金额正确");

    const call = calls.find((c) => c.url.includes("/mapi.php"));
    assert(!!call, "下单请求打到 mapi.php");
    const sent = Object.fromEntries(new URLSearchParams(String(call.init.body)));
    assert(sent.pid === "1001" && sent.type === "alipay", "下单参数包含 pid 与支付方式");
    assert(sent.money === "10.00", "金额按两位小数上送");
    assert(sent.out_trade_no === created.outTradeNo, "上送订单号与返回一致");
    assert(sent.sign === epaySign(sent, PAY_KEY), "下单签名与独立实现一致");
    assert(sent.sign_type === "MD5", "签名类型为 MD5");

    // 12.3 异步回调入账
    const notifyBase = {
      pid: "1001",
      trade_no: "T20261104001",
      out_trade_no: created.outTradeNo,
      type: "alipay",
      trade_status: "TRADE_SUCCESS",
      money: "10.00",
      name: "API 额度充值",
    };
    const notifyUrl = (p) => `/api/pay/epay/notify?${new URLSearchParams({ ...p, sign: epaySign(p, PAY_KEY), sign_type: "MD5" })}`;

    const balBefore = (await (await request("/api/billing/balance", { headers: { cookie: adminCookie } })).json()).balance.available;

    const notifyRes = await request(notifyUrl(notifyBase));
    assert((await notifyRes.text()).trim() === "success", "合法回调返回纯文本 success");

    const balAfter = (await (await request("/api/billing/balance", { headers: { cookie: adminCookie } })).json()).balance.available;
    assert(Math.abs(balAfter - balBefore - 10) < 1e-9, "回调后余额增加 ¥10");

    // 12.4 重复回调必须幂等
    const dupRes = await request(notifyUrl(notifyBase));
    assert((await dupRes.text()).trim() === "success", "重复回调仍返回 success");
    const balDup = (await (await request("/api/billing/balance", { headers: { cookie: adminCookie } })).json()).balance.available;
    assert(Math.abs(balDup - balAfter) < 1e-9, "重复回调未重复加款");

    // 12.5 金额篡改（签名合法但低于订单金额）
    const lowOrder = await (await request("/api/pay/epay/create", { method: "POST", headers, body: { amount: 10, type: "alipay" } })).json();
    const lowBase = { ...notifyBase, out_trade_no: lowOrder.outTradeNo, money: "0.01" };
    const lowRes = await request(notifyUrl(lowBase));
    assert((await lowRes.text()).trim() === "fail", "金额低于订单的回调被拒绝");
    const balLow = (await (await request("/api/billing/balance", { headers: { cookie: adminCookie } })).json()).balance.available;
    assert(Math.abs(balLow - balDup) < 1e-9, "拒绝后余额不变");

    // 12.6 错误密钥签名
    const badSignUrl = `/api/pay/epay/notify?${new URLSearchParams({ ...notifyBase, sign: epaySign(notifyBase, "WRONGKEY"), sign_type: "MD5" })}`;
    const badRes = await request(badSignUrl);
    assert((await badRes.text()).trim() === "fail", "签名错误被拒绝");

    // 12.7 商户号不符
    const wrongPidBase = { ...notifyBase, pid: "9999" };
    const wrongPidRes = await request(notifyUrl(wrongPidBase));
    assert((await wrongPidRes.text()).trim() === "fail", "商户号不符的回调被拒绝");

    // 12.8 订单查询
    const orderRes = await request(`/api/pay/epay/order/${created.outTradeNo}`, { headers: { cookie: adminCookie } });
    assert(orderRes.status === 200, "订单查询 HTTP 200");
    assert((await orderRes.json()).order.status === "paid", "订单状态为已支付");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 13. 视频接口 /v1/videos（agnes 异步任务适配）
{
  const unauth = await request("/v1/videos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { model: "agnes-video-2.5", prompt: "海边日落" },
  });
  assert(unauth.status === 401, "视频创建接口未带 Key 返回 401");

  const unknownModel = await request("/v1/videos", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
    body: { model: "no-such-video-model", prompt: "海边日落" },
  });
  assert([400, 404].includes(unknownModel.status), "未知视频模型被正确拒绝");

  const missingPrompt = await request("/v1/videos", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
    body: { model: "agnes-video-2.5" },
  });
  assert(missingPrompt.status === 400, "缺少 prompt 返回 400");

  const getUnknown = await request("/v1/videos/video_not_exists", {
    headers: { authorization: `Bearer ${apiKeyPlaintext}` },
  });
  assert(getUnknown.status === 404, "不存在的视频任务返回 404");

  const waitUnknown = await request("/v1/videos/video_not_exists/wait?timeout=5", {
    headers: { authorization: `Bearer ${apiKeyPlaintext}` },
  });
  assert(waitUnknown.status === 404, "自动轮询接口对未知任务返回 404");

  const shareNoAuth = await request("/v1/videos/video_not_exists/share", { method: "POST" });
  assert(shareNoAuth.status === 401, "分享链接接口未带 Key 返回 401");

  const statusNoToken = await request("/v1/videos/video_not_exists/status");
  assert(statusNoToken.status === 403, "免 Key 状态查询缺 token 返回 403");

  const watchNoToken = await request("/v1/videos/video_not_exists/watch");
  assert(watchNoToken.status === 403, "观看页缺 token 返回 403");
}

// 14. 图片接口 /v1/images/generations
{
  const unauth = await request("/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { model: "agnes-image-2.1-flash", prompt: "a cat" },
  });
  assert(unauth.status === 401, "图片接口未带 Key 返回 401");

  const chatModel = await request("/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
    body: { model: "agnes-2.5-flash", prompt: "a cat" },
  });
  assert([400, 404].includes(chatModel.status), "对话模型不能走图片接口");

  const missingPrompt = await request("/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
    body: { model: "agnes-image-2.1-flash" },
  });
  assert(missingPrompt.status === 400, "图片接口缺少 prompt 返回 400");
}

// 15. Duck.ai 图片输入（多模态）
{
  const modelRes = await request("/api/admin/actions", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: {
      action: "upsert_model",
      payload: {
        publicName: "mock-duck-image",
        providerId: "duckai",
        upstreamModel: "gpt-5.4-mini",
        inputPerMillion: 0,
        outputPerMillion: 0,
      },
    },
  });
  assert(modelRes.status === 200, "创建 Duck.ai 测试模型映射 HTTP 200");

  const jpegModule = await import("../src/vendor/jpeg-js/index.cjs");
  const jpegLib = jpegModule.default || jpegModule;
  const raw = Buffer.alloc(2 * 2 * 4);
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = 255;
    raw[i + 1] = 0;
    raw[i + 2] = 0;
    raw[i + 3] = 255;
  }
  const jpegBytes = jpegLib.encode({ width: 2, height: 2, data: raw }, 80).data;
  const jpegUrl = `data:image/jpeg;base64,${Buffer.from(jpegBytes).toString("base64")}`;
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const realFetch = globalThis.fetch;
  const chatCalls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("/duckchat/v1/status")) {
      return new Response("{}", {
        status: 200,
        headers: { "x-vqd-hash-1": Buffer.from('(function(){return {client_hashes:["x"]}})()').toString("base64") },
      });
    }
    if (target.includes("/duckchat/v1/chat")) {
      chatCalls.push({ url: target, init });
      return new Response('data: {"type":"message","message":"ok"}\n\ndata: {"type":"done"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const res = await request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: {
        model: "mock-duck-image",
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              { type: "image_url", image_url: { url: jpegUrl } },
              { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } },
            ],
          },
        ],
      },
    });
    assert(res.status === 200, "带图片的 Duck.ai 请求 HTTP 200");
    assert(chatCalls.length > 0, "已向上游发出 chat 请求");
    const sent = JSON.parse(chatCalls[0].init.body);
    const parts = sent.messages?.[0]?.content;
    assert(Array.isArray(parts), "上游 messages content 为 parts 数组");
    assert(parts[0]?.type === "text" && parts[0]?.text === "what is this", "文本 part 保留");
    assert(parts[1]?.type === "image" && parts[1]?.mimeType === "image/png", "JPEG 图片自动转成 PNG");
    assert(String(parts[1]?.image).startsWith("data:image/png;base64,"), "JPEG 转换结果为 PNG data URL");
    assert(parts[2]?.type === "image" && String(parts[2]?.image).includes(pngBase64), "PNG 图片直通不改写");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 16. Duck.ai 联网搜索（来源 / 注解 / 引用标记清理）
{
  const sse = [
    'data: {"type":"message","role":"tool-invocation","toolName":"WebSearch","state":"call","data":{}}',
    'data: {"type":"message","role":"tool-invocation","toolName":"WebSearch","state":"result","data":{"citations":[{"url":"https://a.example/1","title":"A1"},{"url":"https://b.example/2","title":"B2"},{"url":"https://a.example/1","title":"A1 dup"}]}}',
    'data: {"type":"message","role":"assistant","message":"答案是 42"}',
    'data: {"type":"message","role":"assistant","message":"<citation src=\\"1\\">"}',
    'data: {"type":"message","role":"assistant","message":"</citation>，见上。"}',
    'data: [DONE]',
    '',
  ].join('\n\n');
  const realFetch = globalThis.fetch;
  const chatCalls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("/duckchat/v1/status")) {
      return new Response("{}", {
        status: 200,
        headers: { "x-vqd-hash-1": Buffer.from('(function(){return {client_hashes:["x"]}})()').toString("base64") },
      });
    }
    if (target.includes("/duckchat/v1/chat")) {
      chatCalls.push({ init });
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  const collect = (body) => {
    const chunks = String(body)
      .split('\n\n')
      .map((block) => block.trim())
      .filter((block) => block.startsWith('data:'))
      .map((block) => block.slice(5).trim())
      .filter((payload) => payload && payload !== '[DONE]')
      .map((payload) => JSON.parse(payload));
    return chunks;
  };
  try {
    const res = await request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: {
        model: "mock-duck-image",
        stream: false,
        messages: [{ role: "user", content: "现在几点" }],
        tools: [{ type: "web_search" }],
      },
    });
    assert(res.status === 200, "联网搜索请求 HTTP 200");
    const sent = JSON.parse(chatCalls[0].init.body);
    assert(!("metadata" in sent), "不再下发 metadata.toolChoice");
    assert(sent.canUseTools === true, "canUseTools 仍为 true");
    const resJson = await res.json();
    const msg = resJson?.choices?.[0]?.message;
    assert(msg?.content === "答案是 42[1]，见上。", "引用标记被清理为 [1]");
    assert(Array.isArray(msg?.annotations) && msg.annotations.length === 2, "annotations 按 url 去重后为 2 条");
    assert(msg?.annotations?.[0]?.type === "url_citation", "注解类型为 url_citation");
    assert(msg?.sources?.length === 2, "sources 输出 2 条");

    const streamRes = await request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: { model: "mock-duck-image", stream: true, messages: [{ role: "user", content: "现在几点" }], web_search: true },
    });
    assert(streamRes.status === 200, "联网搜索流式请求 HTTP 200");
    const chunks = collect(await streamRes.text());
    const streamed = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || "").join("");
    assert(streamed === "答案是 42[1]，见上。", "流式响应跨 delta 清理引用标记");
    assert(chunks.some((chunk) => Array.isArray(chunk.choices?.[0]?.delta?.annotations)), "流式响应携带 annotations");

    const plainCallsBefore = chatCalls.length;
    const plain = await request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: { model: "mock-duck-image", stream: false, messages: [{ role: "user", content: "普通请求" }] },
    });
    assert(chatCalls.length === plainCallsBefore + 1, "普通请求仍转发上游");
    const plainMsg = (await plain.json())?.choices?.[0]?.message;
    assert(!("annotations" in (plainMsg || {})), "未启用搜索时不输出 annotations");
    assert(plainMsg?.content === '答案是 42<citation src="1"></citation>，见上。', "未启用搜索时保持原有透传行为");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 17. Duck.ai reasoning / 拒答 / 额度 / 结束原因
{
  const realFetch = globalThis.fetch;
  let scenario = "";
  const scenarios = {
    reasoning: [
      'data: {"type":"message","role":"reasoning","state":"text-delta","text":"先想一下。"}',
      'data: {"type":"message","role":"reasoning","state":"done","summaryText":["先想一下。"]}',
      'data: {"type":"message","role":"assistant","message":"答案在这里"}',
      'data: [DONE] [STOP_REASON:max_tokens]',
      '',
    ].join('\n\n'),
    refusal: [
      'data: {"type":"message","role":"refusal","message":"blocked","detectedBy":"model"}',
      'data: [DONE]',
      '',
    ].join('\n\n'),
    limit: ['data: [DONE] [LIMIT_ENTITY]', ''].join('\n\n'),
    limitAccount: ['data: [DONE] [LIMIT_ACCOUNT]', ''].join('\n\n'),
    limitConversation: ['data: [DONE] [LIMIT_CONVERSATION]', ''].join('\n\n'),
  };
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/duckchat/v1/status")) {
      return new Response("{}", {
        status: 200,
        headers: { "x-vqd-hash-1": Buffer.from('(function(){return {client_hashes:["x"]}})()').toString("base64") },
      });
    }
    if (target.includes("/duckchat/v1/chat")) {
      return new Response(scenarios[scenario], { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  const post = (body) => request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
    body: { model: "mock-duck-image", messages: [{ role: "user", content: "hi" }], ...body },
  });
  try {
    scenario = "reasoning";
    const res = await post({ stream: false });
    const msg = (await res.json())?.choices?.[0]?.message;
    assert(res.status === 200, "reasoning 场景 HTTP 200");
    assert(msg?.reasoning_content === "先想一下。", "非流式透传 reasoning_content");
    assert(msg?.content === "答案在这里", "reasoning 不进入正文");
    const fin = (await post({ stream: false }))?.status;
    assert(fin === 200, "reasoning 场景可重复请求");

    scenario = "reasoning";
    const streamRes = await post({ stream: true });
    const chunks = String(await streamRes.text())
      .split("\n\n").map((b) => b.trim()).filter((b) => b.startsWith("data:")).map((b) => b.slice(5).trim())
      .filter((p) => p && p !== "[DONE]").map((p) => JSON.parse(p));
    const reasoningStreamed = chunks.map((c) => c.choices?.[0]?.delta?.reasoning_content || "").join("");
    assert(reasoningStreamed === "先想一下。", "流式透传 reasoning_content");
    assert(chunks.some((c) => c.choices?.[0]?.finish_reason === "length"), "[STOP_REASON:max_tokens] → finish_reason=length");

    scenario = "refusal";
    const refusalRes = await post({ stream: false });
    assert(refusalRes.status === 403, "拒答 → HTTP 403");
    assert((await refusalRes.json())?.error?.code === "content_filter", "拒答 → code=content_filter");

    scenario = "limit";
    const limitRes = await post({ stream: false });
    const limitBody = await limitRes.json();
    assert(limitRes.status === 429, "[LIMIT_ENTITY] → HTTP 429");
    assert(limitBody?.error?.type === "rate_limited", "[LIMIT_ENTITY] → 网关统一限流错误体");

    scenario = "limitAccount";
    const accountRes = await post({ stream: false });
    assert(accountRes.status === 403, "[LIMIT_ACCOUNT] → HTTP 403");
    assert((await accountRes.json())?.error?.code === "upstream_subscription_required", "[LIMIT_ACCOUNT] → code=upstream_subscription_required");

    scenario = "limitConversation";
    const convRes = await post({ stream: false });
    assert(convRes.status === 400, `[LIMIT_CONVERSATION] → HTTP 400（实际 ${convRes.status}）`);
    assert((await convRes.json())?.error?.code === "conversation_limit_reached", "[LIMIT_CONVERSATION] → code=conversation_limit_reached");

    scenario = "refusal";
    const refusalStream = await post({ stream: true });
    const refusalText = await refusalStream.text();
    assert(refusalText.includes('"code":"content_filter"'), "流式拒答以 error 事件收尾");

    scenario = "limit";
    const limitStream = await post({ stream: true });
    assert((await limitStream.text()).includes("user_limit_exceeded"), "流式额度错误以 error 事件收尾");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 18. Duck.ai 图片生成输出
{
  const realFetch = globalThis.fetch;
  const sse = [
    'data: {"type":"message","role":"generated-image","result":"aGVsbG8taW1n","format":"png","width":64,"height":64}',
    'data: {"type":"message","role":"assistant","message":"这是你要的图。"}',
    'data: [DONE]',
    '',
  ].join('\n\n');
  let lastBody = null;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("/duckchat/v1/status")) {
      return new Response("{}", {
        status: 200,
        headers: { "x-vqd-hash-1": Buffer.from('(function(){return {client_hashes:["x"]}})()').toString("base64") },
      });
    }
    if (target.includes("/duckchat/v1/chat")) {
      lastBody = JSON.parse(init.body);
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  const post = (body) => request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
    body: { model: "mock-duck-image", messages: [{ role: "user", content: "画一只猫" }], ...body },
  });
  try {
    const res = await post({ stream: false, tools: [{ type: "image_generation" }] });
    assert(res.status === 200, "图片生成请求 HTTP 200");
    assert(lastBody?.metadata?.toolChoice?.GenerateImage === true, "图片生成下发 toolChoice.GenerateImage");
    const msg = (await res.json())?.choices?.[0]?.message;
    assert(msg?.images?.length === 1, "非流式返回 message.images");
    assert(msg?.images?.[0]?.type === "image_url", "images 类型为 image_url");
    assert(String(msg?.images?.[0]?.image_url?.url).startsWith("data:image/png;base64,"), "图片为 PNG data URL");
    assert(msg?.content === "这是你要的图。", "图片场景正文正常");

    const streamRes = await post({ stream: true, image_generation: true });
    const chunks = String(await streamRes.text())
      .split("\n\n").map((b) => b.trim()).filter((b) => b.startsWith("data:")).map((b) => b.slice(5).trim())
      .filter((p) => p && p !== "[DONE]").map((p) => JSON.parse(p));
    const imageDelta = chunks.find((c) => Array.isArray(c.choices?.[0]?.delta?.images));
    assert(Boolean(imageDelta), "流式返回 delta.images");
    assert(String(imageDelta?.choices?.[0]?.delta?.images?.[0]?.image_url?.url).startsWith("data:image/png;base64,"), "流式图片为 PNG data URL");

    await post({ stream: false, image_generation: false });
    assert(!("metadata" in (lastBody || {})), "未启用图片生成时不下发 metadata");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 19. Duck.ai 图片生成（ui-component 形态，partial → success）
{
  const realFetch = globalThis.fetch;
  const sse = [
    'data: [CHAT_TITLE:cat]',
    'data: {"role":"ui-component","state":"placement","name":"generate-image","toolCallId":"call_1","toolName":"GenerateImage"}',
    'data: {"role":"ui-component","state":"data","name":"generate-image","toolCallId":"call_1","data":{"type":"image-title","title":"drawing"}}',
    'data: {"role":"ui-component","state":"data","name":"generate-image","toolCallId":"call_1","data":{"type":"image-partial","status":"partial","b64Image":"cGFydGlhbA==","format":"jpeg","width":512,"height":512}}',
    'data: {"role":"tool-invocation","state":"result","toolCallId":"call_1","result":"Image generated successfully."}',
    'data: {"role":"ui-component","state":"data","name":"generate-image","toolCallId":"call_1","data":{"status":"success","b64Image":"ZmluYWw=","format":"jpeg","width":1024,"height":1024}}',
    'data: [DONE]',
    '',
  ].join('\n\n');
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/duckchat/v1/status")) {
      return new Response("{}", {
        status: 200,
        headers: { "x-vqd-hash-1": Buffer.from('(function(){return {client_hashes:["x"]}})()').toString("base64") },
      });
    }
    if (target.includes("/duckchat/v1/chat")) {
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  const post = (body) => request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
    body: { model: "mock-duck-image", messages: [{ role: "user", content: "画猫" }], tools: [{ type: "image_generation" }], ...body },
  });
  try {
    const res = await post({ stream: false });
    const msg = (await res.json())?.choices?.[0]?.message;
    assert(msg?.images?.length === 1, "ui-component 形态只输出一张图");
    assert(msg?.images?.[0]?.image_url?.url === "data:image/jpeg;base64,ZmluYWw=", "最终图替换分片图");

    const streamRes = await post({ stream: true });
    const chunks = String(await streamRes.text())
      .split("\n\n").map((b) => b.trim()).filter((b) => b.startsWith("data:")).map((b) => b.slice(5).trim())
      .filter((p) => p && p !== "[DONE]").map((p) => JSON.parse(p));
    const imageDeltas = chunks.filter((c) => Array.isArray(c.choices?.[0]?.delta?.images));
    assert(imageDeltas.length === 1, "流式只下发最终图");
    assert(String(imageDeltas[0]?.choices?.[0]?.delta?.images?.[0]?.image_url?.url).endsWith("ZmluYWw="), "流式最终图正确");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 20. Duck.ai 客户端 function calling 桥
{
  const realFetch = globalThis.fetch;
  let mode = "tool";
  let lastBody = null;
  const toolSse = [
    { type: "message", role: "assistant", message: '```json\n{"tool_call":{"name":"get_weather","argu' },
    { type: "message", role: "assistant", message: 'ments":{"city":"Paris"}}}\n```' },
  ].map((ev) => `data: ${JSON.stringify(ev)}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
  const textSse = 'data: {"type":"message","role":"assistant","message":"今天风和日丽"}\n\ndata: [DONE]\n\n';
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("/duckchat/v1/status")) {
      return new Response("{}", {
        status: 200,
        headers: { "x-vqd-hash-1": Buffer.from('(function(){return {client_hashes:["x"]}})()').toString("base64") },
      });
    }
    if (target.includes("/duckchat/v1/chat")) {
      lastBody = JSON.parse(init.body);
      return new Response(mode === "tool" ? toolSse : textSse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  const tools = [{
    type: "function",
    function: {
      name: "get_weather",
      description: "查询城市天气",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  }];
  const post = (body) => request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
    body: { model: "mock-duck-image", messages: [{ role: "user", content: "巴黎天气" }], ...body },
  });
  const chunksOf = (text) => String(text)
    .split("\n\n").map((b) => b.trim()).filter((b) => b.startsWith("data:")).map((b) => b.slice(5).trim())
    .filter((p) => p && p !== "[DONE]").map((p) => JSON.parse(p));
  try {
    mode = "tool";
    const res = await post({ stream: false, tools });
    assert(res.status === 200, "工具桥非流式请求 HTTP 200");
    const sent = lastBody?.messages?.[0]?.content;
    assert(typeof sent === "string" && sent.includes("[工具调用协议]"), "协议注入首条 user 消息");
    assert(sent.includes("- get_weather: 查询城市天气"), "协议列出工具名与描述");
    const choice = (await res.json())?.choices?.[0];
    assert(choice?.finish_reason === "tool_calls", "非流式 finish_reason=tool_calls");
    const call = choice?.message?.tool_calls?.[0];
    assert(call?.type === "function" && call?.function?.name === "get_weather", "非流式返回标准 tool_calls");
    assert(call?.function?.arguments === '{"city":"Paris"}', "工具参数被解析为 JSON 字符串");
    assert(choice?.message?.content === null, "纯工具调用时 content 为 null");

    const streamRes = await post({ stream: true, tools });
    const chunks = chunksOf(await streamRes.text());
    const deltas = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || []);
    assert(deltas.length === 1, "流式下发 tool_calls delta");
    assert(deltas[0]?.function?.name === "get_weather", "流式 tool_calls 名称正确");
    assert(deltas[0]?.function?.arguments === '{"city":"Paris"}', "流式 tool_calls 参数完整");
    assert(chunks.some((c) => c.choices?.[0]?.finish_reason === "tool_calls"), "流式 finish_reason=tool_calls");

    const historyRes = await post({
      stream: false,
      tools,
      messages: [
        { role: "user", content: "巴黎天气" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", name: "get_weather", content: '{"temp":20}' },
      ],
    });
    assert(historyRes.status === 200, "工具历史回放请求 HTTP 200");
    const historyMessages = lastBody?.messages || [];
    assert(historyMessages.some((m) => String(m.content).includes('[tool_call] get_weather({"city":"Paris"})')), "assistant.tool_calls 回放为文本");
    assert(historyMessages.some((m) => String(m.content).includes('[tool_result] get_weather: {"temp":20}')), "role=tool 回放为工具结果文本");
    assert(historyMessages.every((m) => m.role !== "tool"), "上游不出现 tool role");

    mode = "text";
    const plainRes = await post({ stream: false, tools });
    const plainChoice = (await plainRes.json())?.choices?.[0];
    assert(plainChoice?.message?.content === "今天风和日丽", "无工具调用时正文正常");
    assert(!("tool_calls" in (plainChoice?.message || {})), "无工具调用时不输出 tool_calls");
    assert(plainChoice?.finish_reason === "stop", "无工具调用时 finish_reason=stop");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 21. Duck.ai 上下文 PDF 溢出
{
  const realFetch = globalThis.fetch;
  let lastBody = null;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("/duckchat/v1/status")) {
      return new Response("{}", {
        status: 200,
        headers: { "x-vqd-hash-1": Buffer.from('(function(){return {client_hashes:["x"]}})()').toString("base64") },
      });
    }
    if (target.includes("/duckchat/v1/chat")) {
      lastBody = JSON.parse(init.body);
      return new Response('data: {"type":"message","role":"assistant","message":"已读取上下文"}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  const post = (body) => request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
    body: { model: "mock-duck-image", stream: false, ...body },
  });
  const fileOf = (message) => (Array.isArray(message?.content) ? message.content.find((part) => part.type === "file") : null);
  try {
    const longHistory = "The quick brown fox jumps over the lazy dog. ".repeat(480);
    const res = await post({
      messages: [
        { role: "user", content: longHistory.slice(0, 21000) },
        { role: "assistant", content: "Noted." },
        { role: "user", content: "请总结之前的要点" },
      ],
    });
    assert(res.status === 200, "PDF 溢出请求 HTTP 200");
    const sent = lastBody?.messages || [];
    assert(sent.length === 1, "历史被移出文本消息，只保留当前 user");
    const file = fileOf(sent[0]);
    assert(Boolean(file), "当前 user 消息携带 type=file part");
    assert(file?.mimeType === "application/pdf" && file?.filename === "conversation-context.pdf", "PDF part 元数据正确");
    assert(typeof file?.content === "string" && file.content.startsWith("JVBERi0"), "PDF 内容为 base64 且以 %PDF 开头");
    const textPart = Array.isArray(sent[0]?.content) ? sent[0].content.find((p) => p.type === "text") : null;
    assert(String(textPart?.text || "").includes("请总结之前的要点"), "当前问题保留为文本");
    assert(String(textPart?.text || "").includes("conversation-context.pdf"), "附带 PDF 阅读提示");

    const small = await post({ messages: [{ role: "user", content: "短问题" }] });
    assert(small.status === 200, "未超阈值请求 HTTP 200");
    assert(typeof lastBody?.messages?.[0]?.content === "string", "未超阈值时保持纯文本 content");

    const cjkHistory = "中文上下文内容。".repeat(3000);
    await post({ messages: [{ role: "user", content: cjkHistory }, { role: "user", content: "继续" }] });
    const cjkMessages = lastBody?.messages || [];
    assert(cjkMessages.length === 2, "中文历史无法生成 PDF 时回退为文本");
    assert(!fileOf(cjkMessages[0]), "回退时不附带 file part");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 22. Duck.ai 低价值元数据（标题 / 配额窗口 / 广告 / skill-references）
{
  const realFetch = globalThis.fetch;
  const quota = [{ kind: "chat", remaining: 12, total: 100 }];
  const ads = [{ id: "ad-1", title: "Sponsored" }];
  const doneLine = `data: [DONE][FIXED_COST_WINDOW_USAGE:${encodeURIComponent(JSON.stringify({ windows: quota }))}][ADS:${encodeURIComponent(JSON.stringify(ads))}][WARN_CONVERSATION_LIMIT:80]\n\n`;
  const sse = [
    "data: [CHAT_TITLE:天气讨论]",
    `data: ${JSON.stringify({ type: "quota", windows: quota })}`,
    `data: ${JSON.stringify({ role: "skill-references", skills: [{ name: "summarize" }] })}`,
    `data: ${JSON.stringify({ type: "message", role: "assistant", message: "今天晴。" })}`,
  ].join("\n\n") + "\n\n" + doneLine;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/duckchat/v1/status")) {
      return new Response("{}", {
        status: 200,
        headers: { "x-vqd-hash-1": Buffer.from('(function(){return {client_hashes:["x"]}})()').toString("base64") },
      });
    }
    if (target.includes("/duckchat/v1/chat")) {
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  const post = (stream) => request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
    body: { model: "mock-duck-image", stream, messages: [{ role: "user", content: "天气" }] },
  });
  const chunksOf = (text) => String(text)
    .split("\n\n").map((b) => b.trim()).filter((b) => b.startsWith("data:")).map((b) => b.slice(5).trim())
    .filter((p) => p && p !== "[DONE]").map((p) => JSON.parse(p));
  try {
    const res = await post(false);
    const message = (await res.json())?.choices?.[0]?.message;
    assert(message?.content === "今天晴。", "低价值元数据不影响正文");
    assert(message?.duckai?.title === "天气讨论", "非流式透传会话标题");
    assert(JSON.stringify(message?.duckai?.quota_windows) === JSON.stringify(quota), "非流式透传配额窗口");
    assert(JSON.stringify(message?.duckai?.ads) === JSON.stringify(ads), "非流式透传广告");
    assert(message?.duckai?.conversation_limit_percent === 80, "非流式透传会话额度警告");
    assert(message?.duckai?.skill_references?.[0]?.name === "summarize", "非流式透传 skill-references");

    const streamRes = await post(true);
    const chunks = chunksOf(await streamRes.text());
    const meta = chunks.map((c) => c.choices?.[0]?.delta?.duckai).filter(Boolean).pop();
    assert(meta?.title === "天气讨论", "流式透传会话标题");
    assert(Array.isArray(meta?.quota_windows) && meta.quota_windows.length === 1, "流式透传配额窗口");
    assert(meta?.skill_references?.[0]?.name === "summarize", "流式透传 skill-references");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 22. Codex 渠道生图能力测试
{
  const { openAIToResponsesRequest, collectResponsesStreamToOpenAI, createOpenAIStreamFromResponses, responsesResponseToOpenAI } = await import("../src/responses-translate.ts");

  // 22.1 请求体翻译
  const req1 = openAIToResponsesRequest({
    model: "gpt-image-2",
    messages: [{ role: "user", content: "画一只可爱的猫" }],
  });
  assert(req1.request.tools?.some((t) => t.type === "image_generation"), "生图模型名自动注入 image_generation 工具");
  assert(req1.request.tool_choice?.type === "image_generation", "生图模型名自动强制 tool_choice 为 image_generation");
  assert(req1.request.model === "gpt-5.4-mini", "生图模型名安全回退主模型为 gpt-5.4-mini");

  const req2 = openAIToResponsesRequest({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "画一只小狗" }],
    image_generation: true,
  });
  assert(req2.request.tools?.some((t) => t.type === "image_generation"), "image_generation: true 自动注入生图工具");
  assert(req2.request.tool_choice?.type === "image_generation", "image_generation: true 自动强制生图 tool_choice");

  // 22.2 非流式聚合与响应转换
  const mockB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const mockSse = [
    `data: {"type":"response.output_item.added","item":{"type":"image_generation_call","id":"img_1","status":"in_progress"}}`,
    `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","id":"img_1","status":"completed","result":"${mockB64}","revised_prompt":"一只可爱的蓝猫"}}`,
    `data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":20}}}`,
    `data: [DONE]`,
  ].join("\n\n");

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(mockSse));
      controller.close();
    },
  });

  const collected = await collectResponsesStreamToOpenAI(stream, "gpt-image-2");
  assert(Array.isArray(collected.choices?.[0]?.message?.images), "Codex Responses 非流式输出 message.images");
  assert(collected.choices[0].message.images[0]?.type === "image_url", "图片类型为 image_url");
  assert(collected.choices[0].message.images[0]?.image_url?.url.includes(mockB64), "图片 URL 包含生成的 Base64");
  assert(collected.choices[0].message.images[0]?.revised_prompt === "一只可爱的蓝猫", "保留改写后的 revised_prompt");

  // 22.3 流式转换
  const streamForSse = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(mockSse));
      controller.close();
    },
  });
  const openAiSseStream = createOpenAIStreamFromResponses(streamForSse, "gpt-image-2");
  const reader = openAiSseStream.getReader();
  const chunks = [];
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = dec.decode(value);
    for (const line of text.split("\n")) {
      if (line.startsWith("data:") && !line.includes("[DONE]")) {
        try { chunks.push(JSON.parse(line.slice(5).trim())); } catch {}
      }
    }
  }
  const imageChunk = chunks.find((c) => Array.isArray(c.choices?.[0]?.delta?.images));
  assert(Boolean(imageChunk), "Codex Responses 流式输出 delta.images");
  assert(imageChunk.choices[0].delta.images[0]?.image_url?.url.includes(mockB64), "流式图片 URL 包含 Base64 数据");
}

// 23. Codex 渠道在 /v1/images/generations 接口的端到端派发测试
{
  await request("/api/admin/actions", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: {
      action: "upsert_provider",
      payload: {
        id: "p_mock_codex",
        name: "Mock Codex",
        slug: "codex-test",
        kind: "oauth:codex",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authScheme: "bearer",
        status: "active",
      },
    },
  });
  await request("/api/admin/actions", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: {
      action: "upsert_provider_key",
      payload: {
        providerId: "p_mock_codex",
        key: "rt_mock_token_123456789",
        label: "prod",
      },
    },
  });
  await request("/api/admin/actions", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: {
      action: "upsert_model",
      payload: {
        publicName: "mock-codex-image",
        providerId: "p_mock_codex",
        upstreamModel: "gpt-image-2",
        inputPerMillion: 0,
        outputPerMillion: 0,
      },
    },
  });

  const realFetch = globalThis.fetch;
  const mockB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  let codexCalled = false;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("auth.openai.com/oauth/token")) {
      return new Response(JSON.stringify({
        access_token: "mock-access-token",
        refresh_token: "mock-refresh-token",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/backend-api/codex/responses")) {
      codexCalled = true;
      const sse = `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","id":"img_1","status":"completed","result":"${mockB64}","revised_prompt":"一只可爱的蓝猫"}}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":20}}}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return realFetch(url, init);
  };

  try {
    const res = await request("/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: {
        model: "mock-codex-image",
        prompt: "画一只可爱的猫",
        response_format: "b64_json",
      },
    });
    assert(res.status === 200, "Codex 模型走 /v1/images/generations 接口 HTTP 200");
    const data = await res.json();
    assert(Array.isArray(data.data) && data.data.length > 0, "返回有效图片数组");
    assert(data.data[0].b64_json === mockB64, "返回图片 Base64 与上游一致");
    assert(data.data[0].revised_prompt === "一只可爱的蓝猫", "保留改写后的 revised_prompt");
    assert(codexCalled, "成功触发向 Codex 上游的生图调用");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 24. ChatGPT 网页版渠道在 /v1/images/generations 接口的端到端派发测试
{
  await request("/api/admin/actions", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: {
      action: "upsert_provider",
      payload: {
        id: "p_mock_chatgptweb",
        name: "Mock ChatGPT Web",
        slug: "chatgpt-test",
        kind: "web:chatgptweb",
        baseUrl: "https://chatgpt.com",
        authScheme: "bearer",
        status: "active",
      },
    },
  });
  await request("/api/admin/actions", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: {
      action: "upsert_provider_key",
      payload: {
        providerId: "p_mock_chatgptweb",
        key: "rt_mock_token_chatgpt_web_123",
        label: "prod",
      },
    },
  });
  await request("/api/admin/actions", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: {
      action: "upsert_model",
      payload: {
        publicName: "mock-chatgpt-image",
        providerId: "p_mock_chatgptweb",
        upstreamModel: "auto",
        inputPerMillion: 0,
        outputPerMillion: 0,
      },
    },
  });

  const realFetch = globalThis.fetch;
  const mockB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  let chatgptCalled = false;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("auth.openai.com/oauth/token") || target.includes("auth0.openai.com/oauth/token")) {
      return new Response(JSON.stringify({
        access_token: "mock-web-access-token",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.endsWith("chatgpt.com/")) {
      return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    if (target.includes("/sentinel/chat-requirements/prepare")) {
      return new Response(JSON.stringify({
        prepare_token: "mock-prepare-token",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/sentinel/chat-requirements/finalize")) {
      return new Response(JSON.stringify({
        token: "mock-sentinel-token",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/sentinel/chat-requirements")) {
      return new Response(JSON.stringify({
        token: "mock-sentinel-token",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/backend-api/conversation")) {
      chatgptCalled = true;
      const body = JSON.parse(init.body);
      assert(Array.isArray(body.system_hints) && body.system_hints.includes("picture_v2"), "上游请求体包含 picture_v2 系统提示");
      const sse = `data: {"conversation_id":"conv_123","message":{"content":{"parts":["file-service://file-mock-123"]}}}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (target.includes("/backend-api/files/file-mock-123/download")) {
      return new Response(JSON.stringify({
        status: "success",
        download_url: "https://files.example.com/mock.png",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target === "https://files.example.com/mock.png") {
      return new Response(Buffer.from(mockB64, "base64"), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    return realFetch(url, init);
  };

  try {
    const res = await request("/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: {
        model: "mock-chatgpt-image",
        prompt: "画一个日落海滩",
        response_format: "b64_json",
      },
    });
    assert(res.status === 200, "ChatGPT 网页版模型走 /v1/images/generations 接口 HTTP 200");
    const data = await res.json();
    assert(Array.isArray(data.data) && data.data.length > 0, "返回有效图片数组");
    assert(data.data[0].b64_json === mockB64, "返回图片 Base64 与下载产物一致");
    assert(chatgptCalled, "成功触发向 ChatGPT 网页版上游的 picture_v2 生图调用");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 25. Duck.ai 渠道在 /v1/images/generations 接口的端到端派发测试
{
  const realFetch = globalThis.fetch;
  // 1x1 透明 PNG，带真实魔数，用于校验 detectImageFormat
  const mockB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const chatCalls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("/duckchat/v1/status")) {
      return new Response("{}", {
        status: 200,
        headers: { "x-vqd-hash-1": Buffer.from('(function(){return {client_hashes:["x"]}})()').toString("base64") },
      });
    }
    if (target.includes("/duckchat/v1/chat")) {
      chatCalls.push({ url: target, init });
      const sse = [
        `data: {"role":"ui-component","name":"generate-image","state":"data","data":{"b64Image":"${mockB64}","format":"jpeg","status":"success"}}`,
        "data: [DONE]",
        "",
      ].join("\n\n");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
  };

  try {
    const res = await request("/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: {
        model: "mock-duck-image",
        prompt: "画一只可爱的猫",
        response_format: "b64_json",
      },
    });
    assert(res.status === 200, "Duck.ai 模型走 /v1/images/generations 接口 HTTP 200");
    const data = await res.json();
    assert(Array.isArray(data.data) && data.data.length === 1, "Duck.ai 返回 1 张图片");
    assert(data.data[0].b64_json === mockB64, "Duck.ai 返回图片 Base64 与上游一致");
    assert(data.data[0].format === "png", "按魔数纠正错误的 format（jpeg → png）");
    assert(data.data[0].mime_type === "image/png", "mime_type 与真实格式一致");
    assert(data.data[0].revised_prompt === "画一只可爱的猫", "回显原始 prompt 作为 revised_prompt");
    assert(chatCalls.length > 0, "已向 Duck.ai 上游发出生图请求");
    const sent = JSON.parse(chatCalls[0].init.body);
    assert(sent.metadata?.toolChoice?.GenerateImage === true, "上游请求携带 toolChoice.GenerateImage");
    assert(sent.canDelegateImageGeneration === true, "上游请求携带 canDelegateImageGeneration=true");
  } finally {
    globalThis.fetch = realFetch;
  }

  // 参数校验：n 非法 / response_format 非法
  const badN = await request("/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
    body: { model: "mock-duck-image", prompt: "cat", n: 9 },
  });
  assert(badN.status === 400, "Duck.ai 生图 n=9 返回 400");

  const badFormat = await request("/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
    body: { model: "mock-duck-image", prompt: "cat", response_format: "html" },
  });
  assert(badFormat.status === 400, "Duck.ai 生图 response_format=html 返回 400");
}

// 26. Duck.ai 自然语言生图意图（ZCode 客户端不传 image_generation 字段）
{
  const realFetch = globalThis.fetch;
  const mockB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const chatCalls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("/duckchat/v1/status")) {
      return new Response("{}", {
        status: 200,
        headers: { "x-vqd-hash-1": Buffer.from('(function(){return {client_hashes:["x"]}})()').toString("base64") },
      });
    }
    if (target.includes("/duckchat/v1/chat")) {
      chatCalls.push({ target, init });
      const sse = [
        `data: {"role":"ui-component","name":"generate-image","state":"data","data":{"b64Image":"${mockB64}","format":"jpeg","status":"success"}}`,
        "data: [DONE]",
        "",
      ].join("\n\n");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
  };

  try {
    const res = await request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: {
        model: "mock-duck-image",
        stream: false,
        messages: [{ role: "user", content: "请生成一张小猫图片" }],
      },
    });
    assert(res.status === 200, "自然语言生图请求 HTTP 200（未传 image_generation）");
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    assert(Array.isArray(msg?.images) && msg.images.length === 1, "自然语言生图仍返回 message.images");
    assert(String(msg.images[0]?.image_url?.url).startsWith("data:image/png;base64,"), "图片按魔数修正为 PNG data URL");
    assert(chatCalls.length > 0, "已向上游发出生图对话请求");
    const sent = JSON.parse(chatCalls[0].init.body);
    assert(sent.metadata?.toolChoice?.GenerateImage === true, "自然语言生图意图自动预授权 GenerateImage");
    assert(sent.canDelegateImageGeneration === true, "自然语言生图意图自动设置 canDelegateImageGeneration=true");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 27. 共享生图意图识别
{
  const { looksLikeImageGenerationPrompt, isImageIntentRequest } = await import("../src/image-intent.ts");
  assert(looksLikeImageGenerationPrompt([{ role: "user", content: "请生成一张小猫图片" }]), "中文自然语言识别为生图意图");
  assert(looksLikeImageGenerationPrompt([{ role: "user", content: "Please draw a picture of a cat" }]), "英文自然语言识别为生图意图");
  assert(!looksLikeImageGenerationPrompt([{ role: "user", content: "用 Python 生成图片的代码怎么写" }]), "技术讨论不误判为生图意图");
  assert(isImageIntentRequest({ model: "gpt-6-luna", messages: [{ role: "user", content: "帮我画一幅插画" }] }, "gpt-6-luna"), "共享判断函数支持自然语言");
  assert(!isImageIntentRequest({ model: "gpt-6-luna", messages: [{ role: "user", content: "你好" }] }, "gpt-6-luna"), "普通问候不触发共享生图判断");
}

// 28. Codex 渠道自然语言生图（ZCode 等客户端）
{
  await request("/api/admin/actions", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: {
      action: "upsert_model",
      payload: {
        publicName: "mock-codex-luna",
        providerId: "p_mock_codex",
        upstreamModel: "gpt-6-luna",
        inputPerMillion: 0,
        outputPerMillion: 0,
      },
    },
  });

  const realFetch = globalThis.fetch;
  const mockB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  let codexRequest = null;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("auth.openai.com/oauth/token")) {
      return new Response(JSON.stringify({
        access_token: "mock-access-token",
        refresh_token: "mock-refresh-token",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/backend-api/codex/responses")) {
      codexRequest = JSON.parse(init.body);
      const sse = `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","id":"img_nl","status":"completed","result":"${mockB64}"}}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":5}}}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return realFetch(url, init);
  };

  try {
    const res = await request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: {
        model: "mock-codex-luna",
        stream: false,
        messages: [{ role: "user", content: "请生成一张小猫图片" }],
      },
    });
    assert(res.status === 200, "Codex 自然语言生图 HTTP 200");
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    assert(Array.isArray(msg?.images) && msg.images.length === 1, "Codex 自然语言生图返回 message.images");
    assert(Boolean(codexRequest), "已向 Codex Responses 发出请求");
    assert(codexRequest.model === "gpt-6-luna", "Codex 生图主模型沿用路由配置的 gpt-6-luna");
    assert(codexRequest.tools?.some((t) => t.type === "image_generation" && t.model === "gpt-image-2"), "Codex 请求自动注入 image_generation 工具（gpt-image-2）");
    assert(codexRequest.tool_choice?.type === "image_generation", "Codex 请求自动强制 tool_choice=image_generation");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 29. ChatGPT 网页版自然语言生图（ZCode 等客户端）
{
  await request("/api/admin/actions", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: {
      action: "upsert_model",
      payload: {
        publicName: "mock-chatgpt-luna",
        providerId: "p_mock_chatgptweb",
        upstreamModel: "gpt-6-luna",
        inputPerMillion: 0,
        outputPerMillion: 0,
      },
    },
  });

  const realFetch = globalThis.fetch;
  const mockB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  let conversationBody = null;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("auth.openai.com/oauth/token") || target.includes("auth0.openai.com/oauth/token")) {
      return new Response(JSON.stringify({
        access_token: "mock-web-access-token",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.endsWith("chatgpt.com/")) {
      return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    if (target.includes("/sentinel/chat-requirements/prepare")) {
      return new Response(JSON.stringify({ prepare_token: "mock-prepare" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/sentinel/chat-requirements/finalize")) {
      return new Response(JSON.stringify({ token: "mock-sentinel" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/sentinel/chat-requirements")) {
      return new Response(JSON.stringify({ token: "mock-sentinel" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/backend-api/conversation")) {
      conversationBody = JSON.parse(init.body);
      const sse = `data: {"conversation_id":"conv_nl","message":{"content":{"parts":["file-service://file-nl"]}}}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (target.includes("/backend-api/files/file-nl/download")) {
      return new Response(JSON.stringify({ status: "success", download_url: "https://files.example.com/nl.png" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (target === "https://files.example.com/nl.png") {
      return new Response(Buffer.from(mockB64, "base64"), { status: 200, headers: { "content-type": "image/png" } });
    }
    return realFetch(url, init);
  };

  try {
    const res = await request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyPlaintext}`, "content-type": "application/json" },
      body: {
        model: "mock-chatgpt-luna",
        stream: false,
        messages: [{ role: "user", content: "请生成一张小猫图片" }],
      },
    });
    assert(res.status === 200, "ChatGPT 网页版自然语言生图 HTTP 200");
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    assert(Array.isArray(msg?.images) && msg.images.length === 1, "ChatGPT 网页版自然语言生图返回 message.images");
    assert(Boolean(conversationBody), "已向 ChatGPT 网页版 conversation 发出请求");
    assert(conversationBody.model === "auto", "生图模式自动使用 auto 模型");
    assert(Array.isArray(conversationBody.system_hints) && conversationBody.system_hints.includes("picture_v2"), "生图模式自动携带 picture_v2");
    assert(conversationBody.history_and_training_disabled === false, "生图模式关闭临时对话（临时对话不支持生图）");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n========================================`);
console.log(`🎉 全部测试通过！成功: ${passed}, 失败: ${failed}`);
console.log(`========================================\n`);
