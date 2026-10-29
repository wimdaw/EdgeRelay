# EdgeRelay (腾讯云 EdgeOne Pages + Blob 数据库版本)

> 技术栈：Hono + TypeScript + EdgeOne Pages (Cloud Functions) + EdgeOne Blob 强一致性数据库 + 现代 React/Tailwind 控制台

本项目是 [aynuzbh/EdgeRelay](https://github.com/aynuzbh/EdgeRelay) 的 **腾讯云 EdgeOne Pages + Blob 数据库专属改造版**。
完全移除了对 Cloudflare D1/KV/Workers 的依赖，采用腾讯云 EdgeOne 官方 `@edgeone/pages-blob` SDK 提供底层强一致性（`consistency: "strong"`）文档型数据持久化与通用 KV 缓存。

---

## 🌟 改造亮点与优势

1. **全面适配 EdgeOne Pages 架构**：
   - 云函数入口标准对齐 `onRequest(context)`，底层由高性能轻量框架 `hono` 驱动。
   - 解决 EdgeOne Node 运行时下并发请求体惰性流竞态问题，在入口处进行请求体安全物化。
2. **纯原生 EdgeOne Blob 数据库引擎（方案 A）**：
   - 彻底脱离 D1 SQLite，数据平铺映射为文档型结构（`settings`, `users`, `keys`, `providers`, `models`, `pricing`, `balances`, `usage`, `audit`）。
   - 强一致性读写，杜绝边缘多节点读写分裂。
   - 首次部署**自动自举 Seed 引导数据**，无需手动执行复杂的 SQL 数据库迁移。
3. **首位注册用户自动升级为管理员**：
   - 部署上线后，第一个在界面或接口注册的用户自动赋予 `admin` 权限，免去登录数据库手动修改 role 的麻烦。
4. **前端 SPA 静态资产一体化内嵌**：
   - 前端管理控制台（Landing 官网 + 登录注册 + 全部 Dashboard）产物完整内嵌进云函数 Bundle，彻底杜绝 EdgeOne makers 模式下根目录静态文件 404 的问题。
   - 根路径与页面路由访问时自动注入动态 SEO 标题、站点描述与自定义 Logo。
5. **完整保留原版所有合规与安全特性**：
   - 供应商授权协议编号存证 (`authorization_ref`)。
   - 上游密钥 AES-256-GCM 密文落盘，内存短暂解密。
   - 密码 PBKDF2-SHA256 哈希，API Key 仅存 SHA-256。
   - 审计日志全流程 SHA-256 防篡改哈希链（可验证完整性），按后台保留天数（30–180 天，默认 30 天）自动清理最旧记录。
   - 智能主备路由与 429 故障转移，真实 token 扣费结算与预冻结。

---

## 🚀 快速开始与本地开发

### 环境要求
- Node.js ≥ 20.0

### 安装与构建
```bash
# 1. 安装依赖（已提供 node_modules 软链接或运行 npm install）
npm install

# 2. 生成静态资产内嵌模块
npm run build:assets

# 3. 编译打包 EdgeOne 云函数 Bundle
npm run build:bundle
# 产物输出至 cloud-functions/[[default]].js (约 825 KiB)
```

### 运行自动化测试
项目中已内置完整的端到端回归测试套件（覆盖健康检查、SEO注入、资产分发、首位管理员提权、API Key 创建、模型查询、Step-up 二次验证、钱包充值、防篡改哈希链等 27 项测试）：
```bash
npm run test
```

---

## ☁️ 腾讯云 EdgeOne 部署指南

### 1. 登录 EdgeOne CLI
```bash
# 使用 Pages API Token 登录
edgeone login -t <YOUR_PAGES_API_TOKEN> --site global
```

### 2. 关联 EdgeOne 项目
在项目根目录下创建或配置 `.edgeone/project.json`：
```json
{
  "project_id": "makers-xxxxxx",
  "project_name": "edgerelay"
}
```

### 3. 配置环境变量
在 EdgeOne 控制台的「项目设置 → 环境变量」中配置以下变量：
- `ENCRYPTION_KEY`: 32+ 字节随机字符串（用于 AES-256-GCM 加密上游供应商密钥）
- `SESSION_SECRET`: 32+ 字节随机字符串（用于会话 Cookie 签名）
- `CORS_ORIGINS`: （可选）跨域允许的域名白名单，如 `https://your-domain.com`

### 4. 一键部署发布
```bash
npm run deploy
```

---

## 📋 API 路由一览

| 路径 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | 健康检查（包含引擎与存储标识） |
| `/v1/chat/completions` | POST | OpenAI 兼容对话（流式 SSE、故障转移、计费） |
| `/v1/models` | GET | 对外模型列表（OpenAI 格式） |
| `/api/auth/register` | POST | 用户注册（首位注册者自动成为 admin） |
| `/api/auth/login` | POST | 用户登录（颁发 Session Cookie） |
| `/api/auth/logout` | POST | 用户登出 |
| `/api/auth/me` | GET | 当前登录用户与钱包余额 |
| `/api/auth/stepup` | POST | 管理接口二次验证 |
| `/api/keys` | GET / POST | Key 列表 / 创建 Key（明文仅返回一次） |
| `/api/keys/actions` | POST | Key 撤销 (`revoke`) 或轮换 (`roll`) |
| `/api/billing/balance` | GET | 钱包余额 |
| `/api/billing/ledger` | GET | 消费与充值流水（支持 `?format=csv` 导出） |
| `/api/admin/actions` | POST | 统一管理动作（用户、Key、渠道、模型、定价、充值、设置、审计校验） |
| `/api/admin/stats` | GET | 24小时调用量与延迟统计 |
| `/api/admin/usage/trend`| GET | 用量图表数据走势 |
| `/api/site` | GET | 动态站点信息与 SEO 配置 |
| `/*` | GET | SPA 页面与静态资源分发 |
