# EdgeRelay (EdgeOne Pages + Blob) 开发进度与协同开发指南

> 本文档用于多设备协同开发同步，记录当前项目的完整架构演进、已完成特性矩阵、本地运行/测试指南与后续规划。

---

## 一、 当前项目状态总览 (Current Status)

* **代码仓库**：[`wimdaw/EdgeRelay`](https://github.com/wimdaw/EdgeRelay)
* **核心开发分支**：[`edgeone`](https://github.com/wimdaw/EdgeRelay/tree/edgeone)
* **生产部署环境**：腾讯云 EdgeOne Pages (Makers)
* **生产域名**：
  * 自定义域名：`https://relay.own.cloudns.nz`
  * 预设域名：`https://edgerelay-v95oz4bs.edgeone.dev`
* **运行节点与规格**：锁定分配在 **日本东京 (`ap-tokyo`)** 海外节点，单次请求超时上限已设置为 **120 秒**。

---

## 二、 核心特性实现矩阵 (Feature Matrix)

| 模块 | 实现状态 | 说明 |
|---|---|---|
| **计算引擎** | ✅ 已完成 | 采用高性能 `hono` 框架驱动，标准适配 EdgeOne `onRequest(context)`，带请求体安全物化。 |
| **持久化数据库** | ✅ 已完成 | 采用官方 `@edgeone/pages-blob` SDK，全面取代 D1 SQLite，实现强一致性（`consistency: "strong"`）文档型存储。 |
| **种子数据自举** | ✅ 已完成 | 初次部署启动时，自动注入预设 Providers (OpenAI, Anthropic, Google, DeepSeek)、主流模型路由与初始定价。 |
| **首位用户提权** | ✅ 已完成 | 系统初始状态下，第一位注册用户自动赋予最高管理员（`role: admin`）权限。 |
| **OpenAI 兼容网关** | ✅ 已完成 | `POST /v1/chat/completions` 支持非流式与流式 SSE 透传、主备多路由自动 Failover、429 退避、实际 Token 计费与预冻结。 |
| **模型列表接口** | ✅ 已完成 | 同时支持 OpenAI 兼容的 `/v1/models` 与面向控制台展示的 `/api/models`。 |
| **API Key 管理** | ✅ 已完成 | 支持 `sk-gw-****` 格式生成（明文仅返回一次）、SHA-256 密文存储、Key 额度限制、到期时间、IP/模型白名单、Key 轮换与撤销。 |
| **SMTP 邮件系统** | ✅ 已完成 | 基于 Node.js 原生 `node:tls`（465 隐式 SSL）重构，已打通网易 163 邮箱发件，支持注册动态验证码、免密登录与密码重置。 |
| **前端资产一体化** | ✅ 已完成 | 前端 React/Tailwind 控制台与 Landing 页面完整内嵌打包进云函数 Bundle，解决 EdgeOne Makers 根目录静态文件 404 问题。 |
| **单页路由规范化** | ✅ 已完成 | 前端加入客户端路由安全规范化，访问根目录 `/` 毫秒级自动规范化为 `/#/`，杜绝 CDN 301/302 重定向死循环。 |
| **首页内容可视化** | ✅ 已完成 | 首页大标题、副标语、徽章、支持邮箱支持在后台「设置」动态修改；清除全量旧作者遗留域名与文案；示例代码 URL 自动自适应当前访问域名。 |
| **自动化测试套件** | ✅ 已完成 | 内置 `tests/test-runner.mjs`，包含 32 项自动化端到端单测与模拟集成测试，100% 绿灯通过。 |

---

## 三、 本地协同开发与命令指南

在任何开发设备上拉取 `edgeone` 分支后，即可进行无缝协同开发：

### 1. 克隆与切分支
```bash
git clone https://github.com/wimdaw/EdgeRelay.git
cd EdgeRelay
git checkout edgeone
```

### 2. 环境与依赖
* **Node.js**：建议使用 Node.js ≥ 20.0
* **安装依赖**：
  ```bash
  npm install
  ```

### 3. 构建与打包命令
* **打包静态资产为内嵌 TS 模块**：
  ```bash
  npm run build:assets
  ```
  *(扫描 `public/` 目录，输出为 `src/generated-assets.ts`)*

* **使用 esbuild 编译云函数 Bundle**：
  ```bash
  npm run build:bundle
  ```
  *(编译 `src/edgeone-entry.ts`，输出单文件产物至 `cloud-functions/[[default]].js` 约 840KB，并自动同步到 `dist/`，同时生成 `.edgeone/routes.json`)*

* **一键全量构建**：
  ```bash
  npm run build
  ```

### 4. 运行全量回归测试
```bash
npm run test
# 或执行 node tests/test-runner.mjs
```

---

## 四、 核心配置与环境变量 (Environment Variables)

在 EdgeOne 控制台的「项目设置 → 环境变量」中配置：

| 变量名 | 说明 |
|---|---|
| `ENCRYPTION_KEY` | 32+ 字节高强度随机密钥（用于 AES-256-GCM 密文存储上游 API Key 与发件密码） |
| `SESSION_SECRET` | 32+ 字节高强度随机密钥（用于管理员和用户 Cookie 会话 HMAC 签名） |
| `CORS_ORIGINS` | （可选）跨域允许的白名单域名列表，逗号分隔 |

---

## 五、 部署流程

本仓库已接入 **GitHub Actions / EdgeOne Git 自动化构建部署流水线**：
* 任何设备向 `wimdaw/EdgeRelay` 仓库的 **`edgeone`** 分支提交并推送代码后，EdgeOne 平台会自动抓取最新 Commit，并在 ~40 秒内完成全自动构建上线！
* 亦可在本地通过 EdgeOne CLI 手动发布：
  ```bash
  edgeone login -t <PAGES_API_TOKEN> --site china
  npm run deploy
  ```
