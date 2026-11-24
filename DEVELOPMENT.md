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
| **免 Key 渠道 (Kilo)** | ✅ 已完成 | 接入 Kilo 聚合网关（`https://api.kilo.ai/api/gateway`），内置自举 11 个实测验证全通免费模型（包含 `kilo-auto/free`、`openrouter/free`、Nemotron 3.5 100万超大上下文等），动态拉取上游免费层模型。 |
| **多 Key 轮换与健康熔断** | ✅ 已完成 | 移植 Fisher-Yates 随机打散实现多 Key 均匀负载均衡；集成 429/5xx 熔断降权与 401/402 强熔断，60 秒后自动转入试用（Probation）自愈；控制台支持多 Key 池增删停用与健康状态可视化。 |
| **标准干净网址 (BrowserRouter)** | ✅ 已完成 | 彻底废除 `HashRouter` 与强制追加 `/#/` 的旧脚本，全量升级为标准 HTML5 History 路由，首页为纯原生根路径，内链与外链干净无 `#`，并提供旧书签平滑重定向。 |
| **首屏防闪闭环** | ✅ 已完成 | 静态 `public/index.html` 烘焙正确品牌（Relay），静态标题、`useSiteInfo` 与 Landing 标题三处完全一致；配合单次 `Clear-Site-Data: "cache"` 自愈，彻底消除旧缓存闪烁。 |
| **可收缩侧边栏 (Rail Collapse)** | ✅ 已完成 | 对齐 `ai-gateway-edgeone` 交互，桌面端支持在 224px 与 68px 之间平滑过渡，顶部与底部双向配备切换按钮，折叠态图标居中带原生 Tooltip，`localStorage` 持久化记忆。 |
| **提供商 4 列卡片排布** | ✅ 已完成 | 桌面端重构为 `xl:grid-cols-4`，卡片宽度缩减一半至约 242px，每行容纳 4 个渠道；操作栏紧凑对齐，移动端单列自适应。 |
| **页脚后台可视化配置** | ✅ 已完成 | 控制台「设置 → 站点信息」卡片支持修改「备案号」、「版权文案」和「GitHub 链接」，留空自动隐藏或回退。 |
| **验证码安全与发件规范** | ✅ 已完成 | 有效期 10 分钟、一次性消费；**按用途（注册/登录/重置）严格隔离键空间，不再共用通用键**，重置码不能拿去登录；单码累计输错 5 次即作废，防 6 位数字在线枚举；严格区分「输入错误」「已过期未获取」「错误次数过多」；发件人姓名基于 RFC 5322 规范统一设置为 **`Relay AI`**。 |
| **改密后会话失效** | ✅ 已完成 | 用户记录 `passwordChangedAt`，早于该时间创建的会话一律失效；重置密码踢掉全部设备，控制台改密则为当前设备自动续签新 Cookie，其它设备需重新登录。 |
| **实体 ID 规范化** | ✅ 已完成 | 彻底清除所有供应商与模型映射的历史 `p_`/`m_` 前缀，直接使用 `opencode`、`duckai`、`deepseek`、`openai`。 |
| **热路径极致提速** | ✅ 已完成 | 适配「每次请求全新进程」的 EdgeOne 运行时：配置合并单键 `config:all`、对话走 RTT1/RTT2 两阶段并行、上游请求前最多 2 轮存储往返；用量/Key/限流收尾一次批量落库（数据零丢失）；流式 `tee` 直通 + 客户端 flush 保障记账；首屏前端包 225KB → 74KB。 |

---

## 三、 性能架构（热路径设计）

> **运行环境关键结论（2026-10 实测）**：EdgeOne 云函数**每次请求都是全新进程**（探针确认
> `instance` 每次变化、`requests` 恒为 1，且上下文**无 waitUntil**）。因此：
> 1. 进程内缓存只在**单个请求内**去重（同键多次读只走一次 I/O），不能依赖跨请求复用；
> 2. 所有写入必须在请求生命周期内 `await` 完成，**严禁依赖后台定时器**（进程结束后定时器不执行）；
> 3. 限流必须落 Blob 持久计数，纯内存会完全失效。
>
> EdgeOne Blob 强一致单次读写实测约 100~200ms。原实现一次 `/v1/chat/completions` 要走
> 认证 Key、用户、余额、限流 KV、路由 Key 池、冻结、账本、日汇总、最近列表、用户日列表等
> 十余次串行读写，纯存储开销吃掉 1~3 秒。现在的设计目标：**上游请求前最多 2 轮存储往返**。

### 1. 配置合并单键 `config:all`（`src/storage/db.ts`）
- settings / providers / models / pricing 合并为单键 `config:all`，热路径与全部控制台接口
  一次读取替代四次；缺键时自动从遗留独立键（`settings:platform` / `providers:all` / `models:all` / `pricing:all`）重建并写回。
- 所有管理写入（`updateSettings` / `setProviders` / `setModels` / `setPricing`）同步写回快照 + 遗留键，双写保证回滚兼容。
- 预构建：部署前用脚本把线上数据烘焙进 `config:all`，首个请求也无需重建。

### 2. 对话热路径两阶段并行（`src/routes/chat.ts`）
- **RTT1**：API Key 读取 与 全局配置单键 **并行**（1 轮往返）。
- **RTT2**：渠道 Key 池 + 健康度 + 限流计数（`rl:{keyId}:{minute}` 合并单键）+ 内容安全
  **一轮并行**；付费模型才并入用户/余额读取。
- 免费模型（零定价）完全跳过用户/余额/账本读写；付费模型冻结与结算各一次落库。
- 请求内 TTL 缓存（`TtlCache`）只保证同请求内同键读取单飞。

### 3. 用量 / Key / 限流 一次批量落库（`commitBatch`）
- 对话收尾时 `Promise.all([addUsageRecord（单条/日汇总/最近/用户日四路并行）, commitApiKeyUsage, commitRateLimits])`，
  所有写入在本请求内 await 完成，**进程结束前必定落盘**，数据零丢失。
- 流式响应：`tee` 直通透传，首个字/首个 token 不等待任何记账；客户端分支的 **flush 阶段**
  等待结算 + 批量落库完成后再发 `[DONE]`，代价仅是最末 1~2 轮并行写（约 150~300ms）。
- 余额写穿透：请求内缓存 + 变更立即单键落库；账本按 scope 分组并发读改写。

### 4. 限流持久计数（`src/ratelimit.ts`）
- RPM / TPM / 并发 / 模型 RPM 合并进同一键 `rl:{keyId}:{minute}`：一次读取 + 收尾一次写入。
- 签名 nonce 直接 Blob 单键 + 过期（安全关键，不降级）。
- 超限拒绝请求的增量不必等待提交（下一个请求读取旧值后仍会拒绝），成功路径则必须提交。

### 5. 万级 Key 池调度（`src/router.ts`）
- 路由规划拆成「纯内存规划（配置已缓存）+ 渠道 Key 池/健康度一轮并行读取 + 纯内存构建」。
- 单渠道每次请求最多随机抽样 64 个 Key 参与健康排序与洗牌，万级 Key 池不拖慢单请求。

### 6. 控制台性能
- 用户/Key/渠道列表有界并发读取（12/8 路），趋势图按天并发查询（7~30 天一次并行完成）。
- 配置读取全部命中 `config:all` 单键；审计链/公告请求内单飞缓存。
- 前端控制台页面全部 `React.lazy` 按需加载：首屏不再加载 384KB 的 recharts，
  主包从 225KB 降至 74KB（gzip 23.6KB）。

### 7. 线上实测（部署后 curl）
- `/health` / `/api/site`（缓存命中）：含 EdgeOne 平台冷启动在内的端到端约 0.4~0.9s。
- 对比旧版：每次请求多 3~8 次串行 Blob 往返 + 冷启动自举全量用户扫描（1.5s+）。

---
## 四、 本地协同开发与命令指南

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

## 五、 核心配置与环境变量 (Environment Variables)

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

## 六、 部署流程

本仓库已接入 **GitHub Actions / EdgeOne Git 自动化构建部署流水线**：
* 任何设备向 `wimdaw/EdgeRelay` 仓库的 **`edgeone`** 分支提交并推送代码后，EdgeOne 平台会自动抓取最新 Commit，并在 ~40 秒内完成全自动构建上线！
* 推送必须携带本地代理：
  ```bash
  https_proxy=http://127.0.0.1:10808 http_proxy=http://127.0.0.1:10808 git push origin edgeone
  ```

---

## 七、 后续迭代规划与开发计划 (Roadmap & Development Plan)

### 阶段一：渠道生态扩展与上游连接池优化 (近期计划)
- [x] **接入更多免 Key / 免费体验渠道**：
  - 参考 `ai-gateway-edgeone` 接入 `Kilo` 聚合网关，内置自举 11 个实测验证全通免费模型（`kilo-auto/free`、`openrouter/free`、`nvidia/nemotron-3.5-super-vl:free` 等）。
  - （可选备用）参考 `ai-gateway-edgeone` 接入 `Z.AI` 渠道（GLM 体验模型）。
- [x] **多 Key 轮换与健康熔断机制**：
  - 针对单个付费供应商（如 OpenAI、DeepSeek、Anthropic）支持挂载多个 API Key。
  - 采用 Fisher-Yates 随机打散实现负载均衡；遭遇 429 连续超限或 401/402 终态错误自动进入冷却名单，60 秒后自动转入试用队列（Probation）自愈探测。
  - 控制台配备「密钥池管理」弹窗，支持多 Key 增删停用与健康状态（健康/异常/熔断冷却）实时显示。
- [ ] **超时与重试细粒度控制**：
  - 针对长上下文与深度推理模型，统一受限于 EdgeOne 单次请求上限 120 秒约束，网关层配置 120s 超时保障。

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

---

## 八、 2026-11 渠道能力对齐与发布链路进展

> 本节记录 2026-11 这一轮「Duck.ai 渠道对齐 `duckai-cpa`、Codex 渠道补全、发布链路加固、操练场」的已完成项与已知边界，供后续接手。相关源码位于 `src/duckai*.ts`、`src/opencode*.ts`、`src/video.ts` 及构建脚本。

### 1. 已完成（记进度）

#### 1.1 Duck.ai 渠道：对齐 `duckai-cpa`
- [x] **图片输入**：
  - 客户端传入的 `image_url` 图片统一转为 PNG，最长边限制 ≤ 512px。
  - 内置 `jpeg-js` 解码 JPEG，零额外运行时依赖，以 duck.ai 原生 file / image part 上传。
- [x] **生图模式支持（对齐 `src/openai/images.js`）**：
  - 对话接口：`image_generation: true` / 生图工具 / 生图模型名均可触发，自动下发 `metadata.toolChoice.GenerateImage` 与 `canDelegateImageGeneration=true`，输出 `message.images` / `delta.images`。
  - 图片接口：`/v1/images/generations` 路由支持派发至 Duck.ai 渠道，实现 `n`（1-4）、`response_format`（b64_json/url）、`size` 校验，并用魔数纠正上游返回的图片格式；`n>1` 时串行请求上游。
- [x] **联网搜索与来源注解**：
  - 三路来源（SSE `citations`、`urls`、`source` 事件）合并，按 URL 去重，上限 50 条。
  - 输出为 OpenAI 兼容 `annotations`；对跨 delta 被拆断的引用标记做清理，避免正文出现半截标记。
- [x] **`reasoning_content` 透传**：上游推理片段映射到 `delta.reasoning_content`。
- [x] **refusal / limit / stop_reason 映射**：
  - `refusal` 映射为 403 错误响应。
  - `[LIMIT_*]` 帧转为对应 HTTP 错误。
  - `[STOP_REASON:max_tokens]` 等转为标准 `finish_reason`（如 `length`）。
- [x] **客户端 function calling 桥**（`src/duckai-tools.ts`）：
  - 工具定义协议注入首条 user 消息，兼容 `tool_call` / `tool_calls` 两种上游形态，含跨 delta 拼接与去重。
  - 输出标准 `tool_calls` 与 `finish_reason:"tool_calls"`；`role:"tool"` / `role:"function"` 回放为 `[tool_result]` 文本，assistant 历史中的调用回放为 `[tool_call]`。
- [x] **PDF 上下文溢出**（`src/duckai-pdf.ts`）：
  - 历史消息超过字符上限时，渲染为 PDF 文件 part 随请求上传，保留最后一条 user 消息为原文。
  - 零依赖最小 PDF 生成器，不依赖文件系统与外部字体。
- [x] **低价值元数据透传**（`src/duckai-meta.ts`）：
  - 解析 `[CHAT_TITLE]`、`[FIXED_COST_WINDOW_USAGE]`、`[ADS]`、`[WARN_CONVERSATION_LIMIT]`、`role:"skill-references"` 及 `type:"quota"` / `type:"ad-window"` 事件。
  - 统一挂在非流式 `message.duckai` 与流式 `delta.duckai`，不影响正文。

#### 1.2 Codex 渠道
- [x] **账号池额度查询**：接入 `wham/usage` 拉取账号额度。
- [x] **动态模型清单**：读取 `codex/models`；请求失败时回退到内置静态清单。
- [x] **窗口标签**：按 `window_minutes` 生成额度窗口标签，不再写死。
- [x] **邮箱回填**：从 `id_token` / profile claim 解析并回填账号邮箱。
- [x] **渠道显示名统一**：对外统一显示为 `Codex`。
- [x] **账号池改为手动查询**：额度查询改为手动触发，避免自动轮询。
- [x] **生图模式支持**：
  - 对话接口：自动识别 `image_generation: true` / 工具调用 / `gpt-image-*` 生图模型 / 自然语言生图意图，向 Responses API 注入 `image_generation` 工具；上游返回 `image_generation_call` 统一映射为 `message.images`（流式 `delta.images`）。
  - 图片接口：`/v1/images/generations` 路由支持派发至 Codex 渠道。
  - **已知边界**：实测 `chatgpt.com/backend-api/codex/responses` 对当前 Codex 账号不执行 `image_generation`（gpt-6-luna / gpt-5.6-luna / gpt-5.6-terra 均返回纯文本或 ASCII，强制 tool_choice 会报 “Tool choice 'image_generation' not found in 'tools'”）；Codex access_token 也无法直接复用网页 picture_v2 会话。实际生图请使用 `chatgpt-web/*` 渠道（已验证可出图）。

#### 1.3 ChatGPT 网页版渠道
- [x] **生图模式支持**：
  - 对话接口：自动识别 `image_generation: true` / 工具调用 / 生图模型，自动注入 `system_hints: ['picture_v2']`，解析 SSE 中的 `file-service://...` / `sediment://...` 引用并下载直链图片转为 Base64，挂载 `message.images`（流式 `delta.images`）。
  - 图片接口：`/v1/images/generations` 路由支持派发至 ChatGPT 网页版渠道，完成 PoW 校验与直链下载组装返回。

#### 1.4 发布链路
- [x] **类型检查前置阻断**：服务端 `tsc` 类型检查（`build:typecheck`）纳入 build 流程，类型错误直接阻断构建。
- [x] **修复 7 个既有类型错误**：其中包含 video 用量日志的 `userEmail` 此前未真正落库，现已写入。

#### 1.4 操练场（Playground）
- [x] **绑定当前账户 API Key**：操练场使用当前登录账户自己的 Key，不再借用公共/默认 Key。
- [x] **计入用量与计费**：操练场调用写入 `usage_logs` 并参与计费。
- [x] **菜单调整**：更新图标与菜单位置。

### 2. 明确没做 / 已知边界（待办）

- [ ] **PDF 上下文溢出仅支持 ASCII 历史**：
  - 现状：`src/duckai-pdf.ts` 使用内置 Helvetica / WinAnsi，仅能渲染 ASCII；检测到非 ASCII 时抛 `font_missing`，调用方捕获后回退为纯文本历史，不生成 file part。
  - 原因：EdgeOne 边缘运行时无文件系统，无法读取或内联系统字体；实测尝试 Type0 + STSong-Light + ToUnicode 后，pdf.js 提取仍为乱码，duck.ai 侧模型也无法正确读取。
  - 前置条件：需要一套可在边缘运行时内联、体积可接受的 CJK 子集字体方案（字体烘焙进 bundle 或远端按需加载），并验证 pdf.js 与 duck.ai 均可正确提取中文。

- [ ] **联网搜索为模型自决，无法强制每次必搜**：
  - 现状：搜索开关只是把工具与提示暴露给上游，是否实际发起搜索由模型决定。
  - 原因：参考项目已验证强制模式（`toolChoice.WebSearch`）会与 continuation 流冲突，上游返回 409。
  - 前置条件：需要上游提供可强制、且与 continuation 流兼容的搜索参数；在此之前不建议实现。

- [ ] **function calling 桥的流式为「整条缓冲后回放」**：
  - 现状：`streamResponseWithTools` 先收完整条上游响应再回放，首字延迟等于整条响应耗时。
  - 原因：工具 JSON 参数可能跨多个 delta 拆断，必须完整拼接后才能得到合法参数，属于用首字延迟换正确性。
  - 前置条件：需要另一套增量 JSON 解析（流式状态机），在参数完整前先输出已确定的片段；属独立改造。

- [ ] **`[LIMIT_CONVERSATION]` 使用 400 而非 409**：
  - 现状：会话长度类限制返回 400。
  - 原因：网关会把 409 改写成 502，吞掉原始错误信息；400 可稳定透出。属有意偏差。
  - 前置条件：先修改网关错误分类/透传规则，再考虑改为 409。

- [ ] **Codex 额度未解析 `additional_rate_limits`，且 `client_version` 写死**：
  - 现状：仅解析主额度窗口，模型级限流（`additional_rate_limits`）未展示；`client_version` 固定为 `0.156.1`。
  - 原因：当前未覆盖模型级限流结构；版本号用于客户端伪装，固定值可满足现状。
  - 前置条件：需要真实账号返回含 `additional_rate_limits` 的样本，以及上游要求的最新 `client_version`。若上游收紧版本校验，当前实现会降级（推测：表现为额度查询失败或返回空）。

- [ ] **Codex 渠道不支持「账号—密码—2FA」格式导入**：
  - 现状：仅支持 token / JSON 类凭据导入，账号密码 + 2FA 的导入校验与报错文案尚未收紧。
  - 原因：该登录链路涉及交互式 2FA，尚未实现。
  - 前置条件：需确认是否需要该导入形态；若需要，需提供可测试账号并明确 2FA 密钥（TOTP）的提供方式。

- [ ] **OpenCode 渠道：机房 IP 与 TLS JA4 双门禁**：
  - 现状：实测 Koyeb / EdgeOne / Cloudflare Pages / 普通 VPS 全部返回 429；唯一返回 200 的路径是本机住宅 IP 上的 Bun 中继。
  - 原因：上游同时校验来源 IP 属性（机房 vs 住宅）与 TLS 指纹（JA4），边缘平台出口无法满足。
  - 已证伪方向：IPv6 —— 三家平台均不具备可用独立 IPv6，Cloudflare Workers 为单一共享出口地址，且无法修改 TLS 指纹。
  - 前置条件：可选方向仅剩 (a) 付费 Key 实测；(b) 把中继迁移到家庭低功耗设备（住宅 IP）。需要用户选定方向并提供对应资源。

- [ ] **ai-gateway（Cloudflare Pages）对齐未完成**：
  - 现状：预览环境验证通过，但生产环境 OpenCode 请求返回 530，已回滚到 `1b7f8b33`。
  - 原因：根因尚未确证；`wrangler tail` 对 `_worker.js` 不可用，本机无 Node 环境无法本地复现。
  - 前置条件：下一步增加临时诊断端点采集生产错误。（推测：问题可能出在 Pages 生产环境的 worker 加载或绑定差异，尚待验证。）

- [ ] **ai-gateway-koyeb 已上线，但运维能力存在缺口**：
  - 现状：服务已对齐并上线；Postgres 未备份；deployment id 无法读取。
  - 原因：本机无 Koyeb token。
  - 前置条件：需要用户提供 Koyeb API token；备份需确认数据库连接方式与备份目标。

- [ ] **仓库凭据卫生**：
  - 现状：`pull-ai-gateway.ps1` 含明文 GitHub token；`ai-gateway-koyeb` 源码含硬编码数据库凭据与默认管理员密码。
  - 原因：历史脚本与示例配置直接写死。
  - 前置条件：建议轮换相关 token / 密码并改为环境变量注入；需要用户确认轮换窗口与新的环境变量配置位置。

---

## 九、 2026-11-20 ZCode 渠道接入与 OAuth 双域改造

### 1. 已完成

- [x] **CodeBuddy / WorkBuddy 双域合并为单入口**（`console/src/pages/Providers.tsx`）
  - OAuth 目录由「国内版 / 国际版」两条合并为一条 `CodeBuddy / WorkBuddy (腾讯)`，`regionSelect: true`。
  - 点击授权先弹区域选择（`step: "region"`），国内 `copilot.tencent.com`、国际 `workbuddy.ai`。
  - 底层仍落两个 provider（`codebuddy-oauth` / `codebuddy-global-oauth`），避免同一渠道混用两套账号体系导致鉴权错乱。

- [x] **通用自动签到框架**（`src/checkin.ts`）
  - `CHANNELS` 注册表：新增渠道只需注册 runner，开关 / 心跳 / 手动触发 / 账号池展示自动生效。
  - 开关存 Blob `checkin:config` 的 `disabled` 数组，**默认全部开启**；按渠道分别记录当日去重 `checkin:day:<type>`。
  - 全站心跳 `/api/monitor/video` 驱动，09:00（东八区）后当日首次执行。
  - 动作名按渠道可配：CodeBuddy=`签到`，ZCode=`领额度`（`action` 字段）。
  - 管理动作：`checkin_config` / `set_checkin` / `codebuddy_checkin`（支持 `type`）。
  - 账号池每卡片展示「自动领额度/自动签到」开关 + 「立即领取/立即签到」按钮（`AccountPool.tsx`）。

- [x] **ZCode（智谱）OAuth 渠道**（`src/oauth/zcode.ts`、`src/oauth/zcode-profile.ts`）
  - 设备授权：`POST zcode.z.ai/api/v1/oauth/cli/init`（Bearer 随机 pollToken，`{provider:"zai"}`）→ `GET /api/v1/oauth/cli/poll/{flowId}`。
  - 凭据格式 `jwt|access_token|device_id`，`device_id` 在授权时生成并持久化（对齐参考实现的 `account.device_mid`）。
  - 协议：Anthropic Messages，内部完成 OpenAI ⇄ Anthropic 转换（对齐 ZCode2API 的 `openaiToAnthropic` / `anthropicToOpenAI`），上游固定 `stream:false`，流式由本层合成 SSE。
  - 硬约束：`system` 必须是客户端官方三段原文（`zcode-profile.ts`，10701 字符，由 ZCode2api 的 `zcode-profile.json` 生成，MIT）；应用 system 降级为 `<pi_system_instructions>` 插入首条 user。
  - 请求体恢复 `metadata.user_id`（device_id + session），带 `x-device-mid` / `x-session-id` 等 `x-zcode-*` 头。
  - 登录过期：JWT 无 `exp`，按 `iat + 7 天` 判断，过期返回 401 `login_expired`。
  - 错误映射：`1005/3009` → 429（额度/繁忙）；`3012` → 403（风控）；captcha/verification → 403 `verification_required`。
  - 国内/国际双入口：国际版 `zcode.z.ai`（可设备授权）；国内版 `open.bigmodel.cn/api/anthropic`（该站无设备授权，建渠道后粘贴客户端 `access_token`）。
  - 诊断：`zcode_probe` 返回 JWT claims、balance、preview 及「2 站点 × 2 令牌」矩阵状态。

- [x] **重新授权覆盖旧凭据**（`src/routes/admin.ts`）
  - `upsert_provider_key` 支持 `identity`（账号 uid）：命中旧记录时原地覆盖 `encryptedKey`，不再因指纹变化新增重复账号。

- [x] **可观测性修正**
  - `testZcode` 由「只看 HTTP 状态」改为校验响应体（业务码非 0 / `content` 非数组即判失败），修掉「200 其实 1005」的假阳性。
  - `chat.ts` 非 2xx 时保留上游错误正文（截断 240 字），不再是裸 `status 502`。

### 2. 已知边界（待办）

- [ ] **ZCode 额度校验仍返回 1005**
  - 现状：JWT 在 `zcode.z.ai` 鉴权通过（HTTP 200）但返回 `{"code":1005,"msg":"exceed quota limit"}`；`access_token` 在两个站点均 401；`bigmodel` 站 JWT/access 均 401。
  - 已排除：请求体字段（与后台直测逐字段一致）、站点选择、IP/地域、`max_tokens`、并发放大（已移除渠道内重试）。
  - 待验证：真实 `device_mid`（已改为授权时持久化，需重新授权才生效）、推理请求的 captcha 头（参考实现 `captchasdk`）、客户端 `oauth:bigmodel:access_token`（加密存于 `~/.zcode/v2/credentials.json`）。

- [ ] **captcha 流程未移植**
  - 参考实现 `7sen1ot/zcode2api` 在推理请求前调用 `captchaHeaders(..., CaptchaPurposeInference, ...)`，依赖其 `captchasdk`；协议细节未获取，暂只做错误识别与提示。

- [ ] **ZCode 单账号并发上限低**
  - 上游会返回 `3009 model concurrency limit exceeded`；本层已不叠加重试，建议客户端串行调用。

### 3. 相关提交

| 提交 | 内容 |
|---|---|
| `84a6def` | CodeBuddy 双域合并 + 通用签到框架 |
| `b005e4d2` | ZCode 渠道接入（授权/转换/签到/模型） |
| `5de18406` | 上游非 Anthropic 结构时暴露原始响应 |
| `47786d84` | 非 2xx 保留上游错误正文 |
| `2d9bc5ac` | 并发/频控退避重试 + 签到补齐兜底包 |
| `18805f4c` | 动作名按渠道可配（签到 / 领额度） |
| `4b16a4a1` | 对齐最小可用请求载荷 |
| `7714d05c` | 去掉渠道内重试，避免放大并发限流 |
| `f559afd0` | 连通性测试校验响应体 |
| `85a0c366` | `zcode_probe` 诊断动作 |
| `495ff5ef` | 诊断返回 JWT 身份声明 |
| `f3ae2f99` | 重新授权覆盖旧凭据（identity） |
| `b2e3e171` | 按站点选择接口与令牌 |
| `45448d23` | ZCode 国内/国际双版本 + 站点×令牌矩阵 |
| `99c167b2` | device_id 持久化 / metadata 恢复 / 登录过期判断 |

### 4. 2026-11-20 收尾：对齐 angusdevgo/ZCode2api 基线

- 网关侧实现以 `angusdevgo/ZCode2api` 为基线：`zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`、官方 system 三段原文、`metadata.user_id` 按账号派生、签到走 `billing/preview` + 兜底包 id + `1003` 判定。
- 额外补充（不改变基线行为）：凭据可携带 `access_token` 与真实 `device_id`（`jwt|access|device`），请求头 `x-device-mid` 优先用真实值。
- 当前线上：渠道 `zcode-oauth`，baseUrl `https://zcode.z.ai`，1 个账号，模型 `GLM-5.3` / `GLM-5.3-Flash`，自动领额度开启。
- 待测：账号为 start plan 体验额度，等本周末额度领取后再验证一次；若仍 `1005`，下一步对比客户端请求头（重点看是否含 captcha 类字段）。

---

## 十、 2026-11-20 Qoder 渠道接入

### 1. 已完成

- [x] **设备授权**（`src/oauth/qoder.ts`）
  - PKCE S256 + `/device/selectAccounts` + `/api/v1/deviceToken/poll`。
  - 国内版：`qoder.com.cn`、QoderWork `client_id`、带 `redirect_uri=qoder-work-cn://`、nonce 为带横线 UUID。
  - 国际版：`qoder.com`、Qoder `client_id`、不带 `redirect_uri`、nonce 为 32 位 hex。
  - 授权结果落库为 JSON 凭据（`device_token` / `refresh_token` / `uid` / `user_type` / `region`）。
- [x] **COSY 签名层**（`src/oauth/qoder-cosy.ts`）
  - 自定义 base64 变体（换表 + 1/3 旋转）；9 字段身份体 AES-128-CBC；RSA PKCS#1 v1.5（WebCrypto 不支持，BigInt 模幂）；MD5 请求签名。
  - machineId / machineToken / machineType / hostname 按账号 UID 稳定派生，与 `qoder2api-hub` 逐字节对齐。
- [x] **对话反代**
  - OpenAI ChatCompletions → Qoder `agent_chat_generation` 请求体（`request_id` / `session_id` / `chat_context` / `model_config` / `business` / `tools`）。
  - 上游 SSE 信封解包、工具调用聚合；客户端流式由本层合成 SSE。
- [x] **签到**
  - `GET /sash/api/v1/me/campaigns` 找 `CLAIM_BENEFIT` 可领活动 → `POST .../claim`。
  - 国内版不发指纹头（发了反而不下发活动）；国际版带账号派生指纹，尽力而为。
- [x] **控制台与签到框架**
  - `OAUTH_CATALOG` 新增 Qoder 单入口 + 国内/国际区域选择；按 baseUrl 落 `qoder-oauth` / `qoder-cn-oauth`。
  - `src/checkin.ts` 注册 `qoder` runner，默认开启，随 `/api/monitor/video` 心跳执行。
- [x] **重新授权去重**
  - `upsert_provider_key` 的 `identity` 覆盖逻辑从 ZCode 泛化到 Qoder：同一 uid 重新授权原地覆盖旧凭据，不再新增重复账号。
- [x] **诊断探针**（`qoder_probe`）
  - 一次打穿候选路径矩阵：`/api/v1/userinfo`、`/api/v2/user/plan`、`/api/v2/quota/usage`、`/api/v1/quota/usage`、`/sash/api/v1/me/quota`、`/sash/api/v1/me/credits`、`/sash/api/v1/me/campaigns`，原样回状态码 + 响应片段。
  - 同时返回凭据元信息（区域 / uid / 是否有 refresh_token / 签发天数）与一句结论（令牌失效 / 区域不匹配 / 该区域无活动接口）。
  - 存在原因：参考实现实测国际版 `openapi` 上 `/api/v2/quota/usage` 常 404/403，而 `/sash/api/v1/me/*` 才返回数据；真号接入后不必再猜端点。

### 2. 验证

- `tsc --noEmit -p tsconfig.server.json` ✓
- console `tsc -b` + `vite build` ✓
- `tests/test-qoder-cosy.mjs`：16 项（编码 / 指纹 / 签名形态，向量取自 `qoder2api-hub`）✓
- `tests/test-runner.mjs`：303 项 ✓

### 3. 已知边界（待办）

- [ ] **未用真实账号验证**：授权链接与 COSY 请求体均按参考实现移植，但没有 Qoder 账号跑通过一次完整对话；需要真号点一次授权并测试 `auto` / `qmodel_38max`。
- [ ] **动态模型目录不可用**：上游 `/algo/api/v2/model/list` 要求 GET 携带编码后的 body（签名覆盖 body），Workers/EdgeOne 的 fetch 禁止 GET body；当前使用官方客户端目录兜底。
- [ ] **国际版签到指纹**：参考实现证实自造 `cosy-machinetoken` 不会下发 `CLAIM_BEFEFIT` 活动；当前用账号派生指纹尽力而为，失败时提示需要客户端真实指纹。
- [ ] **Token 自动续期未实现**：Qoder 设备令牌 / refresh_token 约 15 天有效期，过期后需重新授权；参考实现的 jobToken `needRefresh` 续期链路尚未移植。
- [ ] **流式为聚合后回放**：与 ZCode 渠道一致，先收完整条上游 SSE 再合成客户端 SSE，首字延迟等于整条响应耗时。

---

## 十一、 2026-11-20 ZCode 登录迁移（bigmodel → zchat.z.ai / chat.z.ai）

### 1. 实测结论

直接打 `POST https://zcode.z.ai/api/v1/oauth/cli/init` 拿 `authorize_url`，三种 provider 的真实落点：

| provider | authorize host | callback |
| --- | --- | --- |
| `zai` | `https://chat.z.ai/api/oauth/authorize` | `/api/v1/oauth/cli/callback/zai` |
| `zai_cn` | `https://zchat.z.ai/api/oauth/authorize` | `/api/v1/oauth/cli/callback/zai_cn` |
| `bigmodel` | `https://bigmodel.cn/login?appId=zcode` | `/api/v1/oauth/cli/callback/bigmodel` |

- 三者 `client_id` 相同（`client_P8X5CMWmlaRO9gyO-KSqtg`），poll 端点不变。
- `zai_cn` 是唯一可用的国内写法；`cn` / `zhipu` / `zchat` / `glm` / `zai-cn` 等一律返回 `code:1000`。
- `bigmodel.cn/login` 页面仍 200，但微信扫码入口已下线 → 国内只能走 `zai_cn`。
- `zchat.z.ai` 与 `chat.z.ai` 是同一套 Z.ai 应用的两个区域域（首页标题一致），`/api/oauth/authorize` 都存在（缺参返回 422）。

### 2. 本轮改动

- `startZcodeDeviceFlow(env, baseUrl)`：按渠道 `baseUrl` 选 provider，flow 记录 provider 供 poll 使用。
- `pollZcodeDeviceFlow`：`access_token` 兼容 `data.zai` / `data.bigmodel` / `data.access_token` 三种形态；realm 以登录入口为主信号（`zai_cn`/`bigmodel` → cn），避免 customerInfo 缺失时误判国际号。
- `upstreamHeaders` **保持不变**：`http-referer` 固定 `https://zcode.z.ai`，不跟着登录域走。
  领额度走的 `billing/preview`、`billing/claim` 就在这个域上，现有账号一直用这个值且能正常领包；
  跟着登录域改成 `zchat.z.ai` 属于无依据的改动，只会给已跑通的链路添风险。
- `checkinZcode` / `runZcodeProvider` **零改动**：与迁移前逐字节一致，本次迁移不触碰签到链路。
  重新授权后凭据格式不变（`jwt|access|device_id`），签到按 provider `kind` 运行、不依赖 slug，
  因此每日自动领额度不受影响。
- `probeZcode`：返回新增 `login`（provider / authorizeHost / 提示），旧 bigmodel 渠道直接提示「微信扫码已下线」。
- 控制台：ZCode 区域改为「国际版 chat.z.ai」「国内版 zchat.z.ai」；slug 分流 `zcode-oauth` / `zcode-cn-oauth`；bigmodel 仅保留旧渠道兼容并改名「bigmodel·旧」。

### 3. 待验证

- 真号走一遍 `zai_cn` 授权：重点确认 poll 返回的 access_token 字段名（若是 `data.bigmodel` 已被兜底覆盖，但如果两边都没有就是空）。
- 国内号对话仍走 `zcode.z.ai/api/v1/zcode-plan/...`，未按站点切换；若上游按站点隔离，需要在 `handleZcodeRequest` 里按 provider 改 chat host。

---

## 十二、 2026-11-20 Trae 渠道接入（国内版 / 国际版双区）

### 1. 为什么拆成两条渠道

Trae 的国内版与国际版不是"同一套接口换个域名"，而是**两套账号体系 + 两套鉴权方案**：

| 维度 | 国内版 | 国际版 |
| --- | --- | --- |
| 授权页 | `https://www.trae.cn/authorization` | `https://www.trae.ai/authorization` |
| 数据面 | `https://trae-api-cn.mchost.guru` | `https://core-normal.traeapi.us`（备选 `core-normal.trae.ai`、`coresg-normal.trae.ai`） |
| 账号面 | `https://api.trae.com.cn`（备选 `api.trae.cn`） | `https://grow-normal.trae.ai`（备选 `grow-normal.traeapi.us`） |
| 对话鉴权 | `Authorization: Cloud-IDE-JWT <token>` | `Authorization: Bearer <token>` |
| 版本头 | `x-ide-version: 3.4.3` / `code 20260212` | `x-ide-version: 3.6.2` / `code 20260924` |
| UA | `Trae CN/3.4.3` | `TraeClient/TTNet` |
| 区域头 | 无 | `store-country-code: us` |
| 模型目录 | `GET /api/ide/v1/model_list` 可用 | 固定 403 `no schema found`，只能静态目录 |

混用会直接失败：国内号用 `Bearer` 打国际数据面、或国际号用 `Cloud-IDE-JWT`，上游返回 `4015`（被判定风控）而不是 401，非常容易误诊为账号问题。所以按区域落成 `trae-cn-oauth` / `trae-global-oauth` 两条渠道，区域由**渠道 Base URL** 唯一决定。

### 2. 已完成

- [x] **双区注册表**（`src/oauth/trae.ts`）
  - `regionFromBaseUrl()` 判定区域：`trae.cn` / `trae.com.cn` / `mchost.guru` → `cn`，其余 → `global`。
  - `traeEndpoints()` 输出区域端点；`TRAE_CN_CORE_URL` 等环境变量可覆盖，上游改域无需改代码。
  - `TRAE_CN_MODELS` / `TRAE_GLOBAL_MODELS` 兜底目录；国内优先实时 `model_list`。
- [x] **浏览器 OAuth（PKCE S256 + 粘贴回调）**
  - 授权链接按官方客户端参数拼装：`login_version / auth_from=trae / login_channel=native_ide / plugin_version / auth_type=local / client_id / redirect=0 / login_trace_id / auth_callback_url / machine_id / device_id / x_* / code_challenge(S256)`。
  - 回调固定 `http://127.0.0.1:<port>/authorize`：云端收不到 loopback，所以复用 `redirect` 模式的「粘贴回调」交互（与 claude / codex 一致）。
  - `parseTraeCallback()` 兼容五种粘贴形态：完整 URL、纯 query、`authCodeInfo` JSON、`userJwt` JSON、裸 authCode。
- [x] **换票与续期**
  - 回调带 `refreshToken`：直接走 `POST {account}/cloudide/api/v3/trae/oauth/ExchangeToken`（`ClientID/RefreshToken/ClientSecret:"-"/UserID:""`），换票同时完成有效性校验。
  - 回调只带 `authCodeInfo`：走 `POST {account}/trae/api/v3/oauth/ExchangeToken`，带 `CodeVerifier` 与 `DeviceInfo`（P-256 SPKI 公钥）。
  - **refresh_token 轮换**：上游每次换票都签发新 refresh_token 并消费旧的，沿用 `common.resolveAccessToken` 的 KV 链式缓存（`currentRefreshToken`），避免重放导致整条会话作废。
- [x] **对话反代**
  - 主通道 `POST /api/ide/v1/llm_raw_chat`：`{model_name, messages, stream:true, ...采样参数}`；`messages.content` 强制转 parts 数组（字符串会 4001）。
  - 兼容通道 `POST /api/agent/v3/llm_utils_chat`：`function:"chat_v3"` + `request_id` / `session_id`；主通道 404/405 或 4001 时自动降级。
  - SSE 解析 `metadata / output / token_usage / done / error`，转成标准 OpenAI chunk（含 `reasoning_content`、`tool_calls`、末帧 `usage`），非流式在网关内聚合。
  - 未验证的字段（`tools` / `config_name` / `conversation_id` 等）一律不下发，避免 4001。
- [x] **错误码分层**（`mapTraeErrorCode`）
  - `1001/401/403/20101/10101` → 401 鉴权；`4001/400/2001` → 400 参数；
  - `4008/1005/4011/4029` → 429 额度；`4015/4019` → 403 风控；`4023/3003` → 400 模型；其余 → 502。
- [x] **控制台与后台**
  - `OAUTH_CATALOG` 新增 Trae 单入口 + 国内/国际区域选择；按 baseUrl 落 `trae-cn-oauth` / `trae-global-oauth`。
  - `oauth_complete` 透传 `baseUrl`（区域兜底）；`oauth:trae` 纳入「同 uid 重新授权原地覆盖」逻辑，避免重复账号。
- [x] **配置与示例**
  - `env.ts` / `src/types.ts` / `.env.example` 增加 7 个可选变量；默认值即可用，不配置也能跑。

### 3. 入口与路由规则

| 层 | 规则 |
| --- | --- |
| 对外入口 | `POST /v1/chat/completions`、`GET /v1/models`（不新增对外路由） |
| 渠道选择 | 沿用「模型 → 渠道」映射；国内/国际分别上架模型 |
| 区域裁决 | 渠道 `baseUrl` 优先；`baseUrl` 为空时回落凭据内 `region` |
| 显式选边 | 模型前缀 `trae-cn/`、`trae-intl/`、`trae-global/`，前缀不进上游 |
| 前缀冲突 | 前缀区域与渠道区域不一致直接 400，避免"以为走了国际版其实打国内" |
| 上游降级 | `llm_raw_chat` → `llm_utils_chat`；数据面主机 5xx 时按 `coreFallbacks` 切换 |
| 账号池 | 同一渠道多账号时按 `providerKey` 轮换；401/403/429/5xx 换下一个凭据 |

### 4. 配置项

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `TRAE_CN_CORE_URL` | 否 | 国内数据面，默认 `https://trae-api-cn.mchost.guru` |
| `TRAE_GLOBAL_CORE_URL` | 否 | 国际数据面，默认 `https://core-normal.traeapi.us` |
| `TRAE_CN_ACCOUNT_URL` | 否 | 国内账号面，默认 `https://api.trae.com.cn` |
| `TRAE_GLOBAL_ACCOUNT_URL` | 否 | 国际账号面，默认 `https://grow-normal.trae.ai` |
| `TRAE_CLIENT_ID` | 否 | 两区共用 client_id 覆盖，默认 `ono9krqynydwx5` |
| `TRAE_CN_CLIENT_ID` / `TRAE_GLOBAL_CLIENT_ID` | 否 | 按区覆盖，优先级高于 `TRAE_CLIENT_ID` |

其余依赖（`ENCRYPTION_KEY`、`SESSION_SECRET`、Blob 凭据）与现有渠道一致，无新增必填项。

### 5. 本地验证

```bash
# 1) 静态检查
npm run build:typecheck      # tsc --noEmit
npm run build:check          # 未定义标识符扫描

# 2) 双区单测（89 项，锁定区域/端点/鉴权头/协议体/回调/错误码）
node tests/test-trae-region.mjs

# 3) 对话链路（27 项，mock 上游验证鉴权头、SSE → OpenAI、非流式聚合、前缀冲突 400、授权链接）
node tests/test-trae-handler.mjs

# 4) 全量回归（含上面两项，当前 419 项）
npm run test

# 5) 打包（产物 cloud-functions/[[default]].js）
npm run build:bundle
```

控制台手工验证（本地起服务或部署后）：

1. 渠道 → Trae → 选「国内版」：授权页应以 `www.trae.cn` 打开；完成后渠道 slug 为 `trae-cn-oauth`，Base URL 为 `trae-api-cn.mchost.guru`。
2. 再选「国际版」：授权页应以 `www.trae.ai` 打开；渠道 slug 为 `trae-global-oauth`，Base URL 为 `core-normal.traeapi.us`。
3. 两条渠道各点一次「测试」：国内走 `Cloud-IDE-JWT`，国际走 `Bearer`；返回内容即连通。
4. 用 curl 验证路由与降级：

```bash
# 直连国内渠道上架的模型
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3","messages":[{"role":"user","content":"只回答好"}],"stream":false}'

# 双区同名模型用前缀选边（需两条渠道都已上架）
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" -H "Content-Type: application/json" \
  -d '{"model":"trae-intl/glm-5.3","messages":[{"role":"user","content":"hi"}]}'
```

### 6. 关键差异与兼容处理（易踩坑）

1. **鉴权前缀不能混用**：国内 `Cloud-IDE-JWT`、国际 `Bearer`；且 `x-ide-token` 必须与 `Authorization` 里的 token 完全一致，否则 4015。
2. **版本头是硬门槛**：国际版必须带当前客户端版本（`3.6.2 / 20260924`），旧版本头会触发 4015；国内版同理（`3.4.3 / 20260212`）。
3. **`messages.content` 必须是 parts 数组**：`[{"type":"text","text":"..."}]`，传字符串返回 400/4001。
4. **上游恒为 SSE**：即使 `stream:false` 也返回事件流，非流式响应必须由网关聚合。
5. **`model_list` 只在国内开放**：国际版固定 403，导入模型时用内置快照，新增模型手动添加。
6. **refresh_token 一次性**：每次换票都会轮换，必须持久化新 token；并发刷新要用同一份缓存，否则旧 token 重放会作废会话。
7. **设备指纹要稳定**：`machine_id` / `device_id` 按 refresh_token 派生并随凭据落库，重新授权会换新指纹（等同换设备），属于预期行为。
8. **区域不匹配要早失败**：`trae-cn/` 前缀打到国际渠道直接 400，比让上游返回 4015 更容易排查。
9. **工具调用与图片**：`llm_raw_chat` 只验证过文本，`tools` 与图片 part 当前不透传（会 4001）；需要工具调用请走 `llm_utils_chat` 兼容通道或后续单独适配。
10. **不影响既有渠道**：本次全部为新增类型 `oauth:trae` 与新增文件；`parseOAuthKind` 未命中时行为不变，既有 claude/codex/kimi/qwen/grok/codebuddy/cline/zcode/qoder 链路零改动。

### 7. 已知边界（待办）

- [ ] **未用真实账号端到端验证**：协议按 trae2api-hub / trae-api-proxy / cockpit 的公开实现对齐，但当前环境没有 Trae 账号，需真号跑一次授权 + 对话。
- [ ] **AuthCode 换票的设备证明**：只带 `authCodeInfo` 的回调用 `DeviceInfo`（P-256 公钥）换票；若上游要求 `DeviceProof` 签名（CN 设备绑定续期），需要补 ECDSA 签名链路。
- [ ] **模型目录精度**：国内实时目录可用；国际版内置 10 个快照模型，官方新增模型需手动补。
- [ ] **工具调用未验证**：`output.tool_calls` 的字段形态按 OpenAI 风格防御式解析，未用真实工具调用回归。
- [ ] **签到 / 额度查询未接入**：Trae 有 `checkin_credits`（国内）与 `user_current_entitlement_list`（国际），本轮未纳入每日心跳。

---

## 十三、 2026-11-24 AWS Quick guardrail 自动重试

### 1. 问题

ZCode 客户端（provider `new-provider-2`）调用 `awsquick-oauth/amazon-smart` 时偶发：

```text
providerCode=guardrail_blocked
reason=unknown retryable=false
```

上游 HTTP 200，但 SSE 里返回 `guardrail_blocked` 错误事件，客户端把它当成不可重试的业务错误，整个回合直接失败。
失败请求里真正的用户输入只有「你好」，7K prompt tokens 绝大部分来自 ZCode 注入的 system、skills 列表和全局 `AGENTS.md`。

复现结果：同一份完整 messages 重放 12 次，1 次触发；脱敏版本 4 次 0 触发。说明不是稳定的内容拒答，而是上游对长上下文/凭据类内容的偶发或边缘命中。

### 2. 改动

- `src/oauth/awsquick-wire.ts`：新增 `redactQuickSecrets()`，覆盖常见 token、JWT、`Authorization`、password 以及带凭据的连接串。
- `src/oauth/awsquick.ts`：
  - `runQuickTurn` 拆成外层重试 + `runQuickTurnOnce`；
  - 仅在 `guardrail_blocked` 且**尚未向客户端输出任何增量**时重试，最多 2 次；
  - 第 1 次保持原文，排除上游偶发；第 2 次对 prompt/system 脱敏；
  - 已经输出增量后不重试，避免重复内容；非 guardrail 错误行为不变。
- 非流式、流式与 `oauth_test` 共用同一重试逻辑。

### 3. 边界

- 如果护栏在已经输出部分文本后才触发，仍按原错误返回，不能安全重试。
- 脱敏只发生在最后一次重试，正常请求内容不变；响应与日志不会回写脱敏后的 prompt。
- 根因仍是客户端把带凭据的全局记忆原样发给上游；建议客户端侧不要把密钥类内容注入每次请求。

### 4. 验证

```bash
npm run build:typecheck
npm run build:check
node tests/test-awsquick-wire.mjs   # 66 项
node tests/test-awsquick-retry.mjs  # 11 项（本地 WS 假上游，验证伪正文丢弃 + 重试）
npm test                            # 303 项 + 11 项
npm run build:bundle                # 2211.5 KiB
```

发布链：推 `wimdaw/EdgeRelay` 的 `edgeone` 分支后，由 EdgeOne 项目 `relay`（`makers-fdbswhfbvvwm`）自动部署；生产域 `relay.own.cloudns.nz`。

> `.edgeone/project.json` 原先指向空的 `edgerelay` 项目（`makers-wxydbphzqeku`，无自定义域、无环境变量），已改绑到真实生产项目 `relay`，避免本地 `makers deploy` 再次发错项目。

