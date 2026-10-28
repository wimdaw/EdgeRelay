import { useEffect, useState } from "react";
import { Check, Copy, Cpu, Layers, Search, Server } from "lucide-react";
import { api, type Me, type ModelRow } from "../lib/api";
import { Card, EmptyState, Input, useToast } from "../components/ui";
import { cn } from "../lib/utils";

type ProviderBrief = {
  id: string;
  name: string;
  slug: string;
  kind: string;
  status: string;
};

export default function ModelPool({ me: _me }: { me: Me }) {
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [providers, setProviders] = useState<ProviderBrief[]>([]);
  const [search, setSearch] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const toast = useToast();

  const apiBase = `${window.location.origin}/v1`;

  useEffect(() => {
    api<{ models: ModelRow[]; providers?: ProviderBrief[] }>("/api/models")
      .then((d) => {
        setModels(d.models);
        if (d.providers) setProviders(d.providers);
      })
      .catch((e) => toast(e.message, "err"));
  }, []);

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(text);
      toast(`已复制 ${label}: ${text}`);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      toast("复制失败，请手动长按复制", "err");
    }
  };

  const activeModels = (models ?? []).filter((m) => m.enabled === 1);
  const q = search.trim().toLowerCase();

  // 构建提供商分组字典
  const providerGroups: {
    provider: ProviderBrief;
    models: ModelRow[];
  }[] = [];

  const seenPIds = new Set<string>();

  // 1. 基于 providers 列表排序
  for (const p of providers) {
    seenPIds.add(p.id);
    const pModels = activeModels.filter(
      (m) => m.provider_id === p.id || m.provider_slug === p.slug
    );
    providerGroups.push({ provider: p, models: pModels });
  }

  // 2. 兜底未在 providers 数组中的其它模型所属渠道
  for (const m of activeModels) {
    if (m.provider_id && !seenPIds.has(m.provider_id)) {
      seenPIds.add(m.provider_id);
      providerGroups.push({
        provider: {
          id: m.provider_id,
          name: m.provider_name || m.provider_id,
          slug: m.provider_slug || m.provider_id,
          kind: "openai_compat",
          status: "active",
        },
        models: activeModels.filter((x) => x.provider_id === m.provider_id),
      });
    }
  }

  // 过滤搜索
  const filteredGroups = providerGroups
    .map((g) => {
      const matchProvider =
        g.provider.name.toLowerCase().includes(q) ||
        g.provider.slug.toLowerCase().includes(q);
      const matchedModels = g.models.filter(
        (m) =>
          matchProvider ||
          m.public_name.toLowerCase().includes(q) ||
          m.upstream_model.toLowerCase().includes(q) ||
          `${g.provider.slug}/${m.public_name}`.toLowerCase().includes(q)
      );
      return {
        ...g,
        models: matchedModels,
        matches: matchProvider || matchedModels.length > 0,
      };
    })
    .filter((g) => (q ? g.matches : true));

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部总览卡片 */}
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <Layers size={16} />
              </span>
              <h1 className="text-base font-bold text-ink">模型池 (Model Pool)</h1>
            </div>
            <p className="mt-1 text-xs text-muted max-w-2xl">
              已就绪的所有上游大模型目录。模型调用格式统一规范为
              <code className="mx-1 rounded bg-surface2 px-1 text-ink font-mono font-medium">提供商ID/模型ID</code>
              （例如 <span className="font-mono text-ink">deepseek/deepseek-chat</span> 或 <span className="font-mono text-ink">kilo/kilo-auto/free</span>）。点击任意模型胶囊即可一键复制并填入客户端。
            </p>
          </div>

          {/* API Base 地址快速复制 */}
          <div className="flex shrink-0 items-center gap-2 rounded-xl border border-line bg-surface2/60 px-3 py-2 text-xs">
            <span className="text-[11px] font-semibold text-muted shrink-0">API BASE</span>
            <code className="font-mono text-ink truncate max-w-[180px] sm:max-w-[240px]">{apiBase}</code>
            <button
              type="button"
              onClick={() => copyText(apiBase, "API Base")}
              className="ml-auto flex items-center gap-1 rounded-md bg-brand/10 px-2 py-1 text-[11px] font-medium text-brand hover:bg-brand/20 transition-colors"
              title="复制 API 根地址"
            >
              {copiedKey === apiBase ? <Check size={12} /> : <Copy size={12} />}
              <span>{copiedKey === apiBase ? "已复制" : "复制"}</span>
            </button>
          </div>
        </div>

        {/* 概览指标与搜索过滤 */}
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-t border-line/70 pt-3.5">
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted">
            <div>渠道总计：<span className="font-semibold text-ink font-mono">{providers.length}</span></div>
            <div>可用模型：<span className="font-semibold text-emerald-500 font-mono">{activeModels.length}</span> 个</div>
            <div className="hidden sm:inline text-muted/60">·</div>
            <div className="hidden sm:inline">调用格式：<code className="font-mono text-ink">model</code> 或 <code className="font-mono text-ink">provider/model</code></div>
          </div>

          <div className="relative w-full sm:w-72">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索渠道或模型名称..."
              className="!pl-8 !py-1.5 text-xs"
            />
          </div>
        </div>
      </Card>

      {/* 模型目录按渠道分组列表 */}
      {models === null ? (
        <div className="flex flex-col gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="skeleton h-28 rounded-xl2" />
          ))}
        </div>
      ) : filteredGroups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Cpu size={32} />}
            title="未发现匹配的模型"
            hint={q ? "请尝试更换关键词搜索其它渠道或模型" : "暂无可用模型，请联系管理员在「提供商」或「定价」上架模型"}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {filteredGroups.map(({ provider, models: pModels }) => {
            const isKeyless =
              provider.slug === "opencode" ||
              provider.slug === "duckai" ||
              provider.slug === "kilo" ||
              provider.kind === "kilo" ||
              provider.kind === "opencode" ||
              provider.kind === "duckai";

            return (
              <Card key={provider.id} className="p-4 sm:p-4.5 flex flex-col gap-3">
                {/* 渠道信息顶栏 */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-2.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-xs font-bold text-brand">
                      {provider.name[0]?.toUpperCase() || <Server size={14} />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-ink truncate">{provider.name}</span>
                        <code className="text-[10px] text-muted rounded bg-surface2 px-1 py-0.5 font-mono">{provider.slug}</code>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="rounded bg-line/70 px-2 py-0.5 text-[10px] text-muted font-medium">
                      {isKeyless ? "免 Key 直连" : "OpenAI 兼容"}
                    </span>
                    <span className="flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      {pModels.length} 个就绪
                    </span>
                  </div>
                </div>

                {/* 模型胶囊徽章列表（对齐 ai-gateway-edgeone 样式与体验） */}
                {pModels.length === 0 ? (
                  <div className="py-2 text-xs text-muted">该渠道暂无已启用模型</div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {pModels.map((m) => {
                      const fullModelId = m.public_name.startsWith(`${provider.slug}/`)
                        ? m.public_name
                        : `${provider.slug}/${m.public_name}`;
                      const isCopied = copiedKey === fullModelId;

                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => copyText(fullModelId, "模型 ID")}
                          className={cn(
                            "group inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface2/60 px-2.5 py-1.5 text-xs font-mono transition-all hover:border-brand/40 hover:bg-brand/5 hover:text-brand",
                            isCopied && "!border-emerald-500/80 !bg-emerald-500/10 !text-emerald-500 font-semibold"
                          )}
                          title="点击复制模型 ID (提供商ID/模型ID)"
                        >
                          <code className="text-xs font-mono font-medium">{fullModelId}</code>
                          {isCopied ? (
                            <Check size={12} className="text-emerald-500 shrink-0" />
                          ) : (
                            <Copy size={12} className="text-muted/60 group-hover:text-brand shrink-0 transition-colors" />
                          )}
                          {isCopied && <span className="text-[10px] font-sans font-medium text-emerald-500">已复制</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
