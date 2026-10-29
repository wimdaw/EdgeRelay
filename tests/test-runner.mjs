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

console.log(`\n========================================`);
console.log(`🎉 全部测试通过！成功: ${passed}, 失败: ${failed}`);
console.log(`========================================\n`);
