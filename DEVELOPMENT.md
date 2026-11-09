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
| **验证码安全与发件规范** | ✅ 已完成 | 有效期设为 10 分钟单次生成，通用键跨登录/注册/重置共享核验，严格区分「输入错误」与「已过期」，发件人姓名基于 RFC 5322 规范统一设置为 **`Relay AI`**。 |
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

#### 1.3 发布链路
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
