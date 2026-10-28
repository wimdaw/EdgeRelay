/**
 * tests/test-runner.mjs
 * 本地模拟 EdgeOne Cloud Functions 环境，自动化端到端测试
 */
import { onRequest } from "../cloud-functions/[[default]].js";

const env = {
  ENCRYPTION_KEY: "test-encryption-key-32bytes-secret-rand",
  SESSION_SECRET: "test-session-key-32bytes-secret-rand",
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
  assert(html.includes("<title>EdgeRelay — AI API 网关控制台</title>"), "首页成功注入动态 SEO 标题");

  const resAsset = await request("/assets/index-Dv_u8plx.js");
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
  assert(regRes.status === 200, "第一位管理员注册 HTTP 200");
  const regData = await regRes.json();
  assert(regData.user.role === "admin", "首位注册用户自动提权为 admin 角色");
  adminUserId = regData.user.id;

  const setCookie = regRes.headers.get("set-cookie") || "";
  assert(setCookie.includes("gw_session="), "注册成功颁发 gw_session Cookie");
  adminCookie = setCookie.split(";")[0];
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
  assert(loginData.user.email === "admin@edgerelay.test", "登录成功返回正确邮箱");
}

// 5. 查询个人信息与余额
{
  const meRes = await request("/api/auth/me", {
    headers: { cookie: adminCookie },
  });
  assert(meRes.status === 200, "查询个人信息 HTTP 200");
  const meData = await meRes.json();
  assert(meData.user.role === "admin", "身份正确识别为 admin");
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
  assert(keyRes.status === 200, "创建 API Key HTTP 200");
  const keyData = await keyRes.json();
  assert(keyData.key.plaintext.startsWith("sk-gw-"), "成功生成 sk-gw- 格式 API Key");
  apiKeyPlaintext = keyData.key.plaintext;
  apiKeyId = keyData.key.id;

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
  assert(modelIds.includes("gpt-4o"), "成功加载引导数据中的 gpt-4o 模型");
  assert(modelIds.includes("deepseek-chat"), "成功加载引导数据中的 deepseek-chat 模型");
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

console.log(`\n========================================`);
console.log(`🎉 全部测试通过！成功: ${passed}, 失败: ${failed}`);
console.log(`========================================\n`);
