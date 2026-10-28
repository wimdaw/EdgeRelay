/**
 * EdgeRelay (EdgeOne Pages + Blob) — 核心类型定义
 */

export interface Env {
  // 环境变量与密钥
  ENCRYPTION_KEY: string;
  SESSION_SECRET: string;
  ADMIN_BOOTSTRAP_TOKEN?: string;
  CORS_ORIGINS?: string;
  MODERATION_API_URL?: string;
  BILLING_CURRENCY?: string;
  // EdgeOne 相关
  EDGEONE_TOKEN?: string;
  EDGEONE_TOKEN_NEW?: string;
  BLOB_STORE_NAME?: string;
  [key: string]: unknown;
}

export type HandlerCtx = {
  env: Env;
  req: {
    url: string;
    method: string;
    header(name: string): string | undefined;
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
  };
};

export type PlatformSettings = {
  signupsEnabled: boolean;
  requireTosAcceptance: boolean;
  privacyPolicyUrl: string;
  termsOfServiceUrl: string;
  contentModerationEnabled: boolean;
  blocklist: string[];
  logContentEnabled: boolean;
  defaultRpm: number;
  defaultTpm: number;
  auditLogRetentionDays: number;
  /* 安全选项 */
  stepUpDisabled?: boolean;
  persistentSession?: boolean;
  /* 邀请奖励 */
  inviteRegisterReward?: number;
  inviteRewardAmount?: number;
  inviteDailyTop1?: number;
  inviteDailyTop2?: number;
  inviteDailyTop3?: number;
  /* 站点信息与首页展示 */
  siteName?: string;
  siteDescription?: string;
  siteLogoUrl?: string;
  siteHomepage?: string;
  heroBadge?: string;
  heroTitle?: string;
  heroSubtitle?: string;
  supportEmail?: string;
  /* 登录方式 */
  oauthGithubEnabled?: boolean;
  oauthGoogleEnabled?: boolean;
  oauthGithubClientId?: string;
  oauthGoogleClientId?: string;
  oauthGithubSecretEnc?: string;
  oauthGoogleSecretEnc?: string;
  smtpEnabled?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpUsername?: string;
  smtpFrom?: string;
  smtpPassEnc?: string;
};

export const DEFAULT_SETTINGS: PlatformSettings = {
  signupsEnabled: true,
  requireTosAcceptance: true,
  privacyPolicyUrl: "/privacy.html",
  termsOfServiceUrl: "/terms.html",
  contentModerationEnabled: false,
  blocklist: [],
  logContentEnabled: false,
  defaultRpm: 60,
  defaultTpm: 100000,
  auditLogRetentionDays: 180,
  stepUpDisabled: false,
  persistentSession: false,
  siteName: "EdgeRelay",
  siteDescription: "部署在 EdgeOne 边缘的 AI API 网关，用统一 OpenAI 兼容接口接入、路由和派发多家大模型服务。",
  siteLogoUrl: "/logo.png",
  siteHomepage: "",
  heroBadge: "跑在 EdgeOne 全球边缘节点",
  heroTitle: "部署在 EdgeOne 边缘的合规 AI API 网关",
  heroSubtitle: "用统一 OpenAI 兼容接口，接入、路由和治理多家大模型服务。合法授权上游、透明计费、哈希链审计——面向开发者与企业的正规聚合分发平台。",
  supportEmail: "hackerxiaow@gmail.com",
};

export type RateLimits = { rpm: number; tpm: number; concurrency: number };

export type UpstreamRoute = {
  modelId: string;
  providerId: string;
  providerSlug: string;
  providerKind: string;
  baseUrl: string;
  authScheme: string;
  extraHeaders: Record<string, string>;
  providerKeyId: string;
  encryptedKey: string;
  upstreamModel: string;
  priority: number;
  costWeight: number;
};

export type AuthedKey = {
  keyId: string;
  userId: string;
  orgId: string | null;
  requiresSigning: boolean;
  ipWhitelist: string[] | null;
  modelWhitelist: string[] | null;
  limits: RateLimits;
};

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: "user" | "admin" | "finance" | "auditor";
  status: "active" | "suspended" | "banned";
  nickname?: string;
  bio?: string;
  avatarUrl?: string;
  inviteCode?: string;
  invitedBy?: string;
  tosAcceptedAt?: number;
  privacyAcceptedAt?: number;
  stepUpUntil?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  ip?: string;
  userAgent?: string;
}

export interface ApiKeyRecord {
  id: string;
  userId: string;
  orgId?: string | null;
  name: string;
  keyHash: string;
  prefix: string;
  status: "active" | "revoked";
  quotaUsd?: number | null;
  spentUsd: number;
  expiresAt?: number | null;
  ipWhitelist?: string | null; // JSON array string
  modelWhitelist?: string | null; // JSON array string
  requiresSigning: number;
  createdAt: number;
  revokedAt?: number | null;
  lastUsedAt?: number | null;
}

export interface ProviderRecord {
  id: string;
  name: string;
  slug: string;
  kind: string; // openai_compat
  baseUrl: string;
  authScheme: string; // bearer | x-api-key
  extraHeaders?: string | null; // JSON string
  status: "active" | "disabled";
  authorizationRef?: string | null;
  authorizationExpiresAt?: number | null;
  createdAt: number;
}

export interface ProviderKeyRecord {
  id: string;
  providerId: string;
  label: string;
  encryptedKey: string;
  keyFingerprint?: string | null;
  status: "active" | "disabled";
  createdAt: number;
}

export interface ModelRouteRecord {
  id: string;
  publicName: string;
  providerId: string;
  upstreamModel: string;
  priority: number;
  costWeight: number;
  maxContext?: number | null;
  enabled: number;
  createdAt: number;
}

export interface ModelPricingRecord {
  id: string;
  publicName: string;
  inputPerMillion: number;
  outputPerMillion: number;
  currency: string;
  createdAt: number;
}

export interface BalanceRecord {
  id: string;
  scope: string; // user:{id} | org:{id}
  available: number;
  frozen: number;
  currency: string;
  updatedAt: number;
}

export interface LedgerEntryRecord {
  id: string;
  scope: string;
  userId?: string | null;
  type: "topup" | "hold" | "capture" | "release" | "refund" | "adjustment";
  amount: number;
  balanceAfter: number;
  requestId?: string | null;
  memo?: string | null;
  createdAt: number;
}

export interface UsageRecord {
  id: string;
  requestId: string;
  userId: string;
  apiKeyId?: string | null;
  orgId?: string | null;
  publicModel: string;
  providerId?: string | null;
  upstreamModel?: string | null;
  status: string;
  httpStatus?: number | null;
  latencyMs?: number | null;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  currency: string;
  stream: number;
  errorCode?: string | null;
  attempts: number;
  ip?: string | null;
  createdAt: number;
}

export interface DailyUsageSummary {
  date: string;
  requests: number;
  successRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  byModel: Record<string, { requests: number; promptTokens: number; completionTokens: number; costUsd: number }>;
  byProvider: Record<string, { requests: number; promptTokens: number; completionTokens: number }>;
}

export interface AuditLogRecord {
  id: string;
  actorUserId?: string | null;
  actorIp?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  meta?: string | null;
  prevHash?: string | null;
  hash: string;
  createdAt: number;
}

export interface ContentFlagRecord {
  id: string;
  userId: string;
  apiKeyId?: string | null;
  requestId?: string | null;
  publicModel?: string | null;
  rule: string;
  excerptHash?: string | null;
  excerptMasked?: string | null;
  status: "pending" | "cleared" | "confirmed" | "dismissed";
  reviewerId?: string | null;
  reviewNote?: string | null;
  createdAt: number;
  reviewedAt?: number | null;
}

export interface AppealRecord {
  id: string;
  userId: string;
  targetType: string;
  targetId?: string | null;
  reason: string;
  status: "pending" | "resolved" | "rejected";
  createdAt: number;
  resolvedAt?: number | null;
}
