# EdgeRelay (EdgeOne Pages + Blob) 开发进度与协同开发指南

> 本文档用于多设备协同开发同步，记录当前项目的完整架构演进、已完成特性矩阵、本地运行/测试指南与后续迭代开发计划。

---

## 一、 当前项目状态总览 (Current Status)

* **代码仓库**：[`wimdaw/EdgeRelay`](https://github.com/wimdaw/EdgeRelay)
* **核心开发分支**：[`edgeone`](https://github.com/wimdaw/EdgeRelay/tree/edgeone)
* **备用/原版分支**：[`main`](https://github.com/wimdaw/EdgeRelay/tree/main)
* **生产部署环境**：腾讯云 EdgeOne Pages (Makers)
* **生产访问域名**：
  * 自定义域名：`https://relay.own.cloudns.nz`
  * 预设域名：`https://edgerelay-v95oz4bs.edgeone.dev`
* **运行节点与规格**：锁定分配在 **日本东京 (`ap-tokyo`)** 海外节点，单次请求超时上限已设置为 **120 秒**。
* **数据持久化存储**：EdgeOne Blob 强一致数据库 `edgerelay-db` (Project ID: `makers-fdbswhfbvvwm`)。
* **管理员账号**：`hackerxiaow@gmail.com` / `yxy.@990524gdg`

---

## 二、 核心特性实现矩阵 (Feature Matrix)

| 模块 | 实现状态 | 说明 |
|---|---|---|
| **计算引擎** | ✅ 已完成 | 采用高性能 `hono` 框架驱动，标准适配 EdgeOne `onRequest(context)`，带请求体安全物化。 |
| **持久化数据库** | ✅ 已完成 | 采用官方 `@edgeone/pages-blob` SDK，全面取代 D1 SQLite，实现强一致性（`consistency: "strong"`）文档型存储。 |
| **种子数据自举与平滑迁移** | ✅ 已完成 | 首次部署自动自举引导数据；内置 `ensureFreeChannelsSeeded` 自动持久化并同步供应商与全量免费模型。 |
| **首位用户提权** | ✅ 已完成 | 系统初始状态下，第一位注册用户自动赋予最高管理员（`role: admin`）权限。 |
| **OpenAI 兼容网关** | ✅ 已完成 | `POST /v1/chat/completions` 支持非流式与流式 SSE 透传、主备多路由自动 Failover、429 退避、实际 Token 计费与预冻结。 |
| **免 Key 渠道 (OpenCode)** | ✅ 已完成 | 完整移植 `opencode.ts` + `opencode-compat.ts`，自动注入官方 `<env>`、CLI 提示词与 11 官方工具定义，集成 `wreq-js` (Bun 17-cipher) TLS 模拟与镜像轮换。 |
| **免 Key 渠道 (Duck.ai)** | ✅ 已完成 | 实现 `duckai.ts` 原生微沙箱挑战求解（`node:vm` + `parse5`），5ms 内本地求解 DuckDuckGo JS 挑战，配合 `TransformStream` 实时流式转译，零外部容器依赖。 |
| **标准干净网址 (BrowserRouter)** | ✅ 已完成 | 彻底废除 `HashRouter` 与强制追加 `/#/` 的旧脚本，全量升级为标准 HTML5 History 路由，首页为纯原生根路径，内链与外链干净无 `#`，并提供旧书签平滑重定向。 |
| **首屏防闪闭环** | ✅ 已完成 | 静态 `public/index.html` 烘焙正确品牌（Relay），静态标题、`useSiteInfo` 与 Landing 标题三处完全一致；配合单次 `Clear-Site-Data: "cache"` 自愈，彻底消除旧缓存闪烁。 |
| **可收缩侧边栏 (Rail Collapse)** | ✅ 已完成 | 对齐 `ai-gateway-edgeone` 交互，桌面端支持在 224px 与 68px 之间平滑过渡，顶部与底部双向配备切换按钮，折叠态图标居中带原生 Tooltip，`localStorage` 持久化记忆。 |
| **提供商 4 列卡片排布** | ✅ 已完成 | 桌面端重构为 `xl:grid-cols-4`，卡片宽度缩减一半至约 242px，每行容纳 4 个渠道；操作栏紧凑对齐，移动端单列自适应。 |
| **页脚后台可视化配置** | ✅ 已完成 | 控制台「设置 → 站点信息」卡片支持修改「备案号」、「版权文案」和「GitHub 链接」，留空自动隐藏或回退。 |
| **验证码安全与发件规范** | ✅ 已完成 | 有效期设为 10 分钟单次生成，通用键跨登录/注册/重置共享核验，严格区分「输入错误」与「已过期」，发件人姓名基于 RFC 5322 规范统一设置为 **`Relay AI`**。 |
| **实体 ID 规范化** | ✅ 已完成 | 彻底清除所有供应商与模型映射的历史 `p_`/`m_` 前缀，直接使用 `opencode`、`duckai`、`deepseek`、`openai`。 |

---

## 三、 本地协同开发与命令指南

在任何开发设备上拉取 `edgeone` 分支后，即可进行无缝协同开发：

### 1. 克隆与切分支
```bash
# GitHub 必须走本地代理或加速镜像
git clone https://github.com/wimdaw/EdgeRelay.git
cd EdgeRelay
git checkout edgeone
```

### 2. 环境与依赖
* **Node.js**：建议使用 Node.js ≥ 20.0
* **安装依赖**：
  ```bash
  # 因包含 Linux x64 平台专用 TLS 原生依赖，跨平台安装请加 --force
  npm install --force
  ```

### 3. 构建与打包命令
* **构建前端控制台**：
  ```bash
  npm run build:console
  ```

* **烘焙首屏静态信息**：
  ```bash
  npm run build:site-html
  ```

* **打包静态资产为内嵌 TS 模块**：
  ```bash
  npm run build:assets
  ```

* **编译 EdgeOne 云函数 Bundle**：
  ```bash
  npm run build:bundle
  ```
  *(编译 `src/edgeone-entry.ts`，输出单文件产物至 `cloud-functions/[[default]].js` 约 1.08MB，并自动同步到 `dist/`，同时生成 `.edgeone/routes.json`)*

* **一键全量构建**：
  ```bash
  npm run build
  ```

---

## 四、 核心配置与环境变量 (Environment Variables)

在 EdgeOne 控制台的「项目设置 → 环境变量」中配置：

| 变量名 | 说明 |
|---|---|
| `ENCRYPTION_KEY` | 32+ 字节高强度随机密钥（用于 AES-256-GCM 密文存储上游 API Key 与发件密码） |
| `SESSION_SECRET` | 32+ 字节高强度随机密钥（用于管理员和用户 Cookie 会话 HMAC 签名） |
| `CORS_ORIGINS` | （可选）跨域允许的白名单域名列表，逗号分隔 |
| `OPENCODE_MIRRORS_URL` | （可选）自定义 OpenCode 镜像地址，逗号或换行分隔 |
| `OPENCODE_RELAY_URL` | （可选）自定义 OpenCode TLS 中继节点地址 |
| `OPENCODE_RELAY_TOKEN` | （可选）自定义 OpenCode TLS 中继安全令牌 |

---

## 五、 部署流程

本仓库已接入 **GitHub Actions / EdgeOne Git 自动化构建部署流水线**：
* 任何设备向 `wimdaw/EdgeRelay` 仓库的 **`edgeone`** 分支提交并推送代码后，EdgeOne 平台会自动抓取最新 Commit，并在 ~40 秒内完成全自动构建上线！
* 推送必须携带本地代理：
  ```bash
  https_proxy=http://127.0.0.1:10808 http_proxy=http://127.0.0.1:10808 git push origin edgeone
  ```

---

## 六、 后续迭代规划与开发计划 (Roadmap & Development Plan)

### 阶段一：渠道生态扩展与上游连接池优化 (近期计划)
- [ ] **接入更多免 Key / 免费体验渠道**：
  - 参考 `ai-gateway-edgeone` 接入 `Kilo` 聚合渠道（`kilo-auto/frontier`、`kilo-auto/balanced`、`kilo-auto/efficient`、`gemma-3-27b`、`hy3` 等）。
  - 参考 `ai-gateway-edgeone` 接入 `Z.AI` 渠道（GLM 体验模型）。
- [ ] **多 Key 轮换与健康熔断机制**：
  - 针对单个付费供应商（如 OpenAI、DeepSeek、Anthropic）支持挂载多个 API Key。
  - 实现基于权重/轮询的 Key 调度；遭遇 429 或配额耗尽时自动进入冷却名单，冷却时间过后自愈。
- [ ] **超时与重试细粒度控制**：
  - 针对长上下文与深度推理模型（如 `deepseek-reasoner`、`gpt-6-luna`），允许按模型单独设置上游等待超时（最大放宽至 180s）。

### 阶段二：智能路由与安全合规深化 (中期计划)
- [ ] **模型逻辑分组与虚拟别名 (Virtual Model Alias)**：
  - 支持创建 `auto-fast`、`auto-smart`、`auto-coder` 等逻辑聚合别名，网关按预设策略（最低成本、最低延迟、最高优先级）在上游之间自动分流。
- [ ] **增强型敏感词与内容审核 (DFA 离线引擎)**：
  - 内置基于 DFA 确定有穷状态机的高性能离线词库过滤引擎，毫秒级扫描 Prompt，不依赖外部网络即可完成基础合规拦截。
  - 命中敏感词的请求记录截断摘要至 `content_flags` 队列，供合规管理员在后台复核与解封。

### 阶段三：商用化交付与企业级能力 (成熟期计划)
- [ ] **组织与团队协作 (Organizations)**：
  - 支持多租户组织，主账号可邀请成员并为成员或子项目分配独立的配额上限。
  - 部门级用量拆分与账单核算。
- [ ] **自助充值与轻量支付集成**：
  - 接入标准易支付 / V免签协议，支持用户在控制台一键发起充值并自动到账激活额度。
- [ ] **用量报表与账单导出**：
  - 后台与商户中心支持导出 CSV / Excel 详细调用流水，包含精确耗时、Token 用量、费用与 HTTP 状态码。

### 阶段四：双轨部署与多云容灾 (长期规划)
- [ ] **Cloudflare Pages + D1 双轨部署同步**：
  - 持续维护 `main` 分支与 `edgeone` 分支的架构对齐，确保平台可以在 EdgeOne (Node.js 20 + Blob) 与 Cloudflare (V8 + D1) 之间无缝切换。
- [ ] **边缘多区域延迟感知调度**：
  - 结合客户端请求地理位置（GeoIP）自适应选择东京、首尔或香港节点上游，保障最低访问延迟。
