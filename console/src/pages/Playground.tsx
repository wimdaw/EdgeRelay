import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AudioLines, Bot, Copy, Eraser, FlaskConical, Image as ImageIcon, Send, Square, User, Video as VideoIcon } from "lucide-react";
import { api, type KeyRow, type Me } from "../lib/api";
import { Button, Card, Select, useToast } from "../components/ui";
import { cn } from "../lib/utils";

type ModelKind = "chat" | "image" | "video" | "audio";
type ModelItem = { id: string; provider: string; slug: string; paid: boolean; kind: ModelKind };
type VoiceItem = { id: string; label: string; group: string };
type EndpointKey = ModelKind;

/** 端点定义：与后端 /v1 对外暴露的能力一一对应 */
const ENDPOINTS: { key: EndpointKey; label: string; path: string; icon: typeof Bot; hint: string }[] = [
  { key: "chat", label: "对话", path: "/v1/chat/completions", icon: Bot, hint: "OpenAI Chat Completions · 流式输出" },
  { key: "image", label: "图片", path: "/v1/images/generations", icon: ImageIcon, hint: "OpenAI Images API · 同步返回图片" },
  { key: "video", label: "视频", path: "/v1/videos/generations", icon: VideoIcon, hint: "异步任务 · 提交后自动轮询到完成" },
  { key: "audio", label: "音频", path: "/v1/audio/speech", icon: AudioLines, hint: "内置 Edge TTS（免费）· 文本转语音" },
];

const KIND_EMPTY_HINT: Record<EndpointKey, string> = {
  chat: "暂无可用对话模型",
  image: "当前没有分类到图片端点的模型（支持 agnes-image / Codex / ChatGPT / Duck.ai 渠道）",
  video: "当前没有可用的视频模型（支持 agnes-video 系列）",
  audio: "音频走内置 Edge TTS，任意账号可用，无需选择模型",
};

type Msg = {
  id: string;
  role: "user" | "assistant";
  endpoint: EndpointKey;
  content: string;
  error?: string;
  model?: string;
  tokens?: number;
  /** 图片：url 或 base64；视频/音频：播放地址 */
  mediaUrl?: string;
  mediaMime?: "image" | "video" | "audio";
  /** 视频：任务轮询状态 */
  taskId?: string;
  taskStatus?: string;
  taskProgress?: number;
  taskWaitingSlot?: boolean;
};

const uid = () => Math.random().toString(36).slice(2, 10);

export default function Playground({ me }: { me: Me }) {
  const [models, setModels] = useState<ModelItem[]>([]);
  const [endpoint, setEndpoint] = useState<EndpointKey>("chat");
  const [model, setModel] = useState("");
  const [system, setSystem] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [imageSize, setImageSize] = useState("1024x1024");
  const [imageN, setImageN] = useState(1);
  const [videoSize, setVideoSize] = useState("1280x720");
  const [videoSeconds, setVideoSeconds] = useState("5");
  const [voices, setVoices] = useState<VoiceItem[]>([]);
  const [voice, setVoice] = useState("zh-CN-XiaoxiaoNeural");
  const [audioRate, setAudioRate] = useState("+0%");
  const [audioVolume, setAudioVolume] = useState("+0%");
  const [audioPitch, setAudioPitch] = useState("+0Hz");
  const [previewing, setPreviewing] = useState(false);
  /** 用户手动点过端点选项卡后为 true：此后选模型不再自动跳端点（尊重手动选择） */
  const [manualEndpoint, setManualEndpoint] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [keyId, setKeyId] = useState("");
  const [keysLoaded, setKeysLoaded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const videoPollRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();

  useEffect(() => {
    api<{ models: ModelItem[] }>("/api/playground/models")
      .then((d) => {
        setModels(d.models);
        const firstChat = d.models.find((m) => m.kind === "chat");
        setModel((m) => m || (firstChat ? canonicalId(firstChat) : d.models[0] ? canonicalId(d.models[0]) : ""));
      })
      .catch((e) => toast((e as Error).message, "err"));
    api<{ voices: VoiceItem[] }>("/api/playground/voices")
      .then((d) => {
        setVoices(d.voices || []);
        setVoice((v) => v || d.voices?.[0]?.id || "zh-CN-XiaoxiaoNeural");
      })
      .catch(() => {});
  }, []);

  // 默认使用当前账户自己名下的 Key（最新的可用一条），可在下拉中切换
  useEffect(() => {
    api<{ keys: KeyRow[] }>("/api/keys")
      .then((d) => {
        const active = d.keys.filter((k) => k.status === "active").sort((a, b) => b.created_at - a.created_at);
        setKeys(active);
        const now = Date.now() / 1000;
        const usable = active.find(
          (k) => (!k.expires_at || k.expires_at > now) && (k.quota_usd === null || k.spent_usd < k.quota_usd)
        );
        setKeyId((cur) => cur || usable?.id || active[0]?.id || "");
      })
      .catch((e) => toast((e as Error).message, "err"))
      .finally(() => setKeysLoaded(true));
  }, []);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [msgs]);

  // 清理视频轮询
  useEffect(() => () => { if (videoPollRef.current) window.clearInterval(videoPollRef.current); }, []);

  /** 规范调用格式：渠道ID/模型名（与模型池一致，可精确路由到渠道） */
  const canonicalId = (m: ModelItem) => `${m.slug}/${m.id}`;
  /**
   * 按供应商分组（一目了然：顶部渠道、底下它的模型）。
   * 含当前端点推荐模型的渠道排前；渠道内推荐模型（✓ 标记）排前。
   */
  const groupedProviders = useMemo(() => {
    const map = new Map<string, ModelItem[]>();
    for (const m of models) {
      const arr = map.get(m.provider) || [];
      arr.push(m);
      map.set(m.provider, arr);
    }
    const entries = [...map.entries()].map(([prov, list]) => {
      const rec = list.filter((m) => m.kind === endpoint);
      const rest = list.filter((m) => m.kind !== endpoint);
      return { prov, list: [...rec, ...rest], recN: rec.length };
    });
    entries.sort((a, b) => (b.recN > 0 ? 1 : 0) - (a.recN > 0 ? 1 : 0) || a.prov.localeCompare(b.prov));
    return entries.map((e) => [e.prov, e.list] as const);
  }, [models, endpoint]);
  /** 音色按语言分组 */
  const voiceGroups = useMemo(() => {
    const map = new Map<string, VoiceItem[]>();
    for (const v of voices) {
      const arr = map.get(v.group) || [];
      arr.push(v);
      map.set(v.group, arr);
    }
    return [...map.entries()];
  }, [voices]);
  /** 音频端点不需要模型 */
  const needModel = endpoint !== "audio";
  const activeModel = models.find((m) => canonicalId(m) === model);
  /** 模型与端点不匹配时给出自动切换提示 */
  const modelMismatch = needModel && !!activeModel && activeModel.kind !== endpoint;

  /**
   * 切换端点：手动操作。保留当前选择的模型（分类不匹配也能跨端点尝试），
   * 下拉里会用「推荐」分组提示该端点的原生模型。
   */
  const switchEndpoint = (next: EndpointKey) => {
    setManualEndpoint(true);
    setEndpoint(next);
  };

  /** 选择模型：自动匹配对应端点（如选了图片模型自动切到图片端点） */
  const pickModel = (id: string) => {
    setModel(id);
    const m = models.find((x) => canonicalId(x) === id);
    if (m && m.kind !== endpoint) {
      if (manualEndpoint) {
        // 用户手动选过端点：尊重当前端点，允许跨端点尝试（如能生图的对话模型走图片端点）
        return;
      }
      setEndpoint(m.kind);
      toast(`已自动切换到「${ENDPOINTS.find((e) => e.key === m.kind)?.label}」端点`);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (videoPollRef.current) { window.clearInterval(videoPollRef.current); videoPollRef.current = null; }
    setBusy(false);
  };

  const clear = () => {
    stop();
    setMsgs([]);
  };

  const patch = (id: string, fn: (m: Msg) => Msg) =>
    setMsgs((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));

  /** 音色试听：用当前音色/语速/音量/音调合成一句固定示例 */
  const previewVoice = async () => {
    if (previewing) return;
    setPreviewing(true);
    try {
      const resp = await fetch("/api/playground/speech", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "edge-tts", input: "你好，这是当前音色的试听效果。", voice, rate: audioRate, volume: audioVolume, pitch: audioPitch, key_id: keyId }),
      });
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      if (!resp.ok || !ct.startsWith("audio")) {
        const data = await resp.json().catch(() => null);
        toast(data?.error?.message ?? "试听失败", "err");
        return;
      }
      const blob = await resp.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      void audio.play();
    } catch (e) {
      toast((e as Error).message || "试听失败", "err");
    } finally {
      setPreviewing(false);
    }
  };

  const precheck = (text: string): boolean => {
    if (!text || busy) return false;
    if (!keyId) {
      toast("当前账户没有可用的 API Key，请先到「API 密钥」页创建", "err");
      return false;
    }
    if (needModel && !model) {
      toast("请先选择模型", "err");
      return false;
    }
    return true;
  };

  /* ---- 对话（流式） ---- */
  const sendChat = async (text: string) => {
    const userMsg: Msg = { id: uid(), role: "user", endpoint: "chat", content: text };
    const assistantId = uid();
    const history = [...msgs.filter((m) => m.endpoint === "chat"), userMsg].map((m) => ({ role: m.role, content: m.content }));

    setMsgs((prev) => [...prev, userMsg, { id: assistantId, role: "assistant", endpoint: "chat", content: "", model }]);
    setInput("");
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const resp = await fetch("/api/playground/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: history, system, temperature, max_tokens: maxTokens, stream: true, key_id: keyId }),
        signal: ctrl.signal,
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => null);
        patch(assistantId, (m) => ({ ...m, error: data?.error?.message ?? `请求失败 (${resp.status})` }));
        return;
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new Error("浏览器不支持流式读取");
      const decoder = new TextDecoder();
      let buffer = "";
      let usageTokens = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload && payload !== "[DONE]") {
              try {
                const j = JSON.parse(payload);
                const delta = j?.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta) {
                  patch(assistantId, (m) => ({ ...m, content: m.content + delta }));
                }
                if (j?.usage) {
                  usageTokens =
                    typeof j.usage.total_tokens === "number"
                      ? j.usage.total_tokens
                      : (j.usage.prompt_tokens || 0) + (j.usage.completion_tokens || 0);
                }
              } catch {
                // 忽略无法解析的心跳帧
              }
            }
          }
          nl = buffer.indexOf("\n");
        }
      }
      if (usageTokens) patch(assistantId, (m) => ({ ...m, tokens: usageTokens }));
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        patch(assistantId, (m) => ({ ...m, error: (e as Error).message || "请求失败" }));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  /* ---- 图片（同步） ---- */
  const sendImage = async (text: string) => {
    const userMsg: Msg = { id: uid(), role: "user", endpoint: "image", content: text };
    const assistantId = uid();
    setMsgs((prev) => [...prev, userMsg, { id: assistantId, role: "assistant", endpoint: "image", content: "", model }]);
    setInput("");
    setBusy(true);
    try {
      const resp = await fetch("/api/playground/images", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: text, size: imageSize, n: imageN, key_id: keyId }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        patch(assistantId, (m) => ({ ...m, error: data?.error?.message ?? `请求失败 (${resp.status})` }));
        return;
      }
      const first = data?.data?.[0];
      const url = typeof first?.url === "string" ? first.url : "";
      const b64 = typeof first?.b64_json === "string" ? first.b64_json : "";
      if (!url && !b64) {
        patch(assistantId, (m) => ({ ...m, error: "上游未返回图片数据" }));
        return;
      }
      patch(assistantId, (m) => ({
        ...m,
        mediaUrl: url || `data:image/png;base64,${b64}`,
        mediaMime: "image",
        content: "",
      }));
    } catch (e) {
      patch(assistantId, (m) => ({ ...m, error: (e as Error).message || "请求失败" }));
    } finally {
      setBusy(false);
    }
  };

  /* ---- 视频（异步任务 + 轮询） ---- */
  const sendVideo = async (text: string) => {
    const userMsg: Msg = { id: uid(), role: "user", endpoint: "video", content: text };
    const assistantId = uid();
    setMsgs((prev) => [...prev, userMsg, { id: assistantId, role: "assistant", endpoint: "video", content: "", model, taskStatus: "提交中" }]);
    setInput("");
    setBusy(true);
    try {
      const resp = await fetch("/api/playground/videos", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: text, size: videoSize, seconds: videoSeconds, key_id: keyId }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        // 排队等待（队列满挂本地重投）也带 task_id，照常轮询
        const waitTaskId = typeof data?.task_id === "string" ? data.task_id : "";
        if (!waitTaskId) {
          patch(assistantId, (m) => ({ ...m, error: data?.error?.message ?? `请求失败 (${resp.status})` }));
          return;
        }
        patch(assistantId, (m) => ({ ...m, taskId: waitTaskId, taskStatus: "queued", taskWaitingSlot: true, error: data?.error?.message }));
      } else {
        patch(assistantId, (m) => ({ ...m, taskId: String(data?.id ?? ""), taskStatus: String(data?.status ?? "queued"), taskProgress: Number(data?.progress) || 0 }));
      }

      const taskId = String(data?.task_id || data?.id || "");
      if (!taskId) return;

      // 轮询到终态
      let attempts = 0;
      const timer = window.setInterval(async () => {
        attempts++;
        try {
          const r = await api<{ task: Record<string, any> }>(`/api/playground/videos/${taskId}`);
          const t = r.task || {};
          patch(assistantId, (m) => ({
            ...m,
            taskId,
            taskStatus: String(t.status ?? m.taskStatus),
            taskProgress: Number(t.progress) || m.taskProgress || 0,
            mediaUrl: typeof t.url === "string" && t.url ? t.url : m.mediaUrl,
          }));
          const st = String(t.status);
          if (st === "completed" || st === "failed" || st === "cancelled" || attempts > 120) {
            if (videoPollRef.current) { window.clearInterval(videoPollRef.current); videoPollRef.current = null; }
            if (st === "failed" || st === "cancelled") {
              patch(assistantId, (m) => ({ ...m, error: t?.error?.message || `任务${st === "failed" ? "失败" : "已取消"}` }));
            }
            setBusy(false);
          }
        } catch {
          // 单次轮询失败忽略，下个周期重试
        }
      }, 5000);
      videoPollRef.current = timer;
    } catch (e) {
      patch(assistantId, (m) => ({ ...m, error: (e as Error).message || "请求失败" }));
      setBusy(false);
    }
    // 视频不阻塞输入：busy 保持到任务终态由轮询解除
  };

  /* ---- 音频（同步，返回二进制） ---- */
  const sendAudio = async (text: string) => {
    const userMsg: Msg = { id: uid(), role: "user", endpoint: "audio", content: text };
    const assistantId = uid();
    setMsgs((prev) => [...prev, userMsg, { id: assistantId, role: "assistant", endpoint: "audio", content: "" }]);
    setInput("");
    setBusy(true);
    try {
      const resp = await fetch("/api/playground/speech", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "edge-tts", input: text, voice, rate: audioRate, volume: audioVolume, pitch: audioPitch, key_id: keyId }),
      });
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      if (!resp.ok || !ct.startsWith("audio")) {
        const data = await resp.json().catch(() => null);
        patch(assistantId, (m) => ({ ...m, error: data?.error?.message ?? `请求失败 (${resp.status})` }));
        return;
      }
      const blob = await resp.blob();
      patch(assistantId, (m) => ({ ...m, mediaUrl: URL.createObjectURL(blob), mediaMime: "audio", model: `${voice} · ${audioRate}` }));
    } catch (e) {
      patch(assistantId, (m) => ({ ...m, error: (e as Error).message || "请求失败" }));
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    const text = input.trim();
    if (!precheck(text)) return;
    if (endpoint === "chat") return sendChat(text);
    if (endpoint === "image") return sendImage(text);
    if (endpoint === "video") return sendVideo(text);
    return sendAudio(text);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制");
    } catch {
      toast("复制失败", "err");
    }
  };

  const inputPlaceholder =
    endpoint === "image" ? "描述你想生成的图片…" 
    : endpoint === "video" ? "描述你想生成的视频…"
    : endpoint === "audio" ? "输入要转成语音的文本…"
    : "输入内容…";

  const videoRunning = msgs.some((m) => m.endpoint === "video" && !!m.taskId && !["completed", "failed", "cancelled"].includes(m.taskStatus || "") && !m.error);
  const sendLabel = videoRunning ? "生成中…" : busy ? "处理中…" : "发送";

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <FlaskConical size={18} />
            </div>
            <div>
              <h1 className="text-base font-bold text-ink">操练场</h1>
              <p className="mt-0.5 text-xs text-muted">
                使用你账户自己的 API Key 调用，走网关同一套路由；每分钟最多 20 次，不计量。
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" className="h-9" onClick={clear} disabled={!msgs.length}>
              <Eraser size={14} /> 清空
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[320px,1fr]">
        {/* 参数面板 */}
        <Card className="h-fit p-4">
          <div className="space-y-3">
            {/* 端点选择 */}
            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted">API 端点</label>
              <div className="grid grid-cols-4 gap-1 rounded-lg bg-surface2 p-1">
                {ENDPOINTS.map((e) => {
                  const Icon = e.icon;
                  return (
                    <button
                      key={e.key}
                      type="button"
                      title={e.hint}
                      onClick={() => switchEndpoint(e.key)}
                      className={cn(
                        "inline-flex flex-col items-center gap-1 rounded-md px-1 py-1.5 text-[11px] font-medium transition-colors",
                        endpoint === e.key ? "bg-surface text-brand shadow-sm" : "text-muted hover:text-ink"
                      )}
                    >
                      <Icon size={14} />
                      {e.label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 font-mono text-[10px] text-muted">{ENDPOINTS.find((e) => e.key === endpoint)?.path}</p>
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted">API Key</label>
              {keys.length > 0 ? (
                <>
                  <Select value={keyId} onChange={(e) => setKeyId(e.target.value)} className="w-full">
                    {keys.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name} · {k.prefix}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-1 text-[10px] text-muted">只使用当前账户自己名下的 Key</p>
                </>
              ) : (
                <div className="rounded-lg border border-line bg-surface2 px-2.5 py-2 text-[11px] leading-relaxed text-muted">
                  {keysLoaded ? (
                    <>
                      当前账户还没有可用的 API Key，请先到{" "}
                      <Link to="/dashboard/keys" className="font-medium text-brand hover:underline">
                        API 密钥
                      </Link>{" "}
                      页创建。
                    </>
                  ) : (
                    "正在读取你的 API Key…"
                  )}
                </div>
              )}
            </div>

            {/* 模型（音频端点不需要） */}
            {needModel ? (
              <div>
                <label className="mb-1 block text-[11px] font-medium text-muted">模型</label>
                {models.length > 0 ? (
                  <Select value={model} onChange={(e) => pickModel(e.target.value)} className="w-full">
                    {!models.some((m) => canonicalId(m) === model) && <option value="">请选择模型</option>}
                    {groupedProviders.map(([prov, list]) => (
                      <optgroup key={prov} label={`${prov}（${list.length}）`}>
                        {list.map((m) => (
                          <option key={`${m.slug}/${m.id}`} value={canonicalId(m)}>
                            {m.kind === endpoint ? "✓ " : ""}
                            {canonicalId(m)}
                            {m.paid ? "（付费）" : ""}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </Select>
                ) : (
                  <div className="rounded-lg border border-line bg-surface2 px-2.5 py-2 text-[11px] text-muted">{KIND_EMPTY_HINT[endpoint]}</div>
                )}
                <p className="mt-1 text-[10px] text-muted">
                  {modelMismatch
                    ? `当前模型分类属于「${ENDPOINTS.find((e) => e.key === activeModel?.kind)?.label}」，已按你的手动选择保留在当前端点`
                    : me.user.role === "superadmin" || me.user.role === "admin"
                    ? "管理员可见全部模型（含付费）；推荐组为该端点原生模型"
                    : "普通用户仅显示免费模型"}
                </p>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between">
                  <label className="mb-1 block text-[11px] font-medium text-muted">音色（{voices.length} 个，按语言分组）</label>
                  <button
                    type="button"
                    className="text-[11px] font-medium text-brand hover:underline disabled:opacity-50"
                    disabled={previewing || !keyId}
                    onClick={previewVoice}
                  >
                    {previewing ? "生成试听中…" : "▶ 试听当前音色"}
                  </button>
                </div>
                <Select value={voice} onChange={(e) => setVoice(e.target.value)} className="w-full">
                  {voiceGroups.map(([group, list]) => (
                    <optgroup key={group} label={group}>
                      {list.map((v) => (
                        <option key={v.id} value={v.id}>{v.label} · {v.id.replace(/Neural$/, "")}</option>
                      ))}
                    </optgroup>
                  ))}
                  {!voices.some((v) => v.id === voice) && <option value={voice}>{voice}</option>}
                </Select>
                <p className="mt-1 font-mono text-[10px] text-muted">{voice}</p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <div>
                    <label className="mb-1 block text-[10px] font-medium text-muted">语速</label>
                    <Select value={audioRate} onChange={(e) => setAudioRate(e.target.value)} className="w-full">
                      {["-50%", "-25%", "-10%", "+0%", "+10%", "+25%", "+50%", "+100%"].map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] font-medium text-muted">音量</label>
                    <Select value={audioVolume} onChange={(e) => setAudioVolume(e.target.value)} className="w-full">
                      {["-50%", "-25%", "+0%", "+25%", "+50%"].map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] font-medium text-muted">音调</label>
                    <Select value={audioPitch} onChange={(e) => setAudioPitch(e.target.value)} className="w-full">
                      {["-20%", "-10%", "+0%", "+10%", "+20%"].map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </Select>
                  </div>
                </div>
              </div>
            )}

            {endpoint === "chat" && (
              <>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-muted">系统提示词（可选）</label>
                  <textarea
                    value={system}
                    onChange={(e) => setSystem(e.target.value)}
                    rows={3}
                    placeholder="例如：你是一个简洁的助手，回答不超过三句话。"
                    className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-2 text-[12px] text-ink outline-none focus:border-brand/60"
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[11px] font-medium text-muted">温度</label>
                  <span className="font-mono text-[11px] text-ink">{temperature.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                  className="w-full accent-brand"
                />
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-muted">最大输出 tokens</label>
                  <input
                    type="number"
                    min={16}
                    max={8192}
                    value={maxTokens}
                    onChange={(e) => setMaxTokens(Math.max(16, Math.min(8192, Number(e.target.value) || 1024)))}
                    className="w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-[12px] text-ink outline-none focus:border-brand/60"
                  />
                </div>
              </>
            )}

            {endpoint === "image" && (
              <>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-muted">尺寸</label>
                  <Select value={imageSize} onChange={(e) => setImageSize(e.target.value)} className="w-full">
                    {["1024x1024", "1024x1792", "1792x1024", "512x512", "768x768"].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-muted">张数</label>
                  <input
                    type="number"
                    min={1}
                    max={4}
                    value={imageN}
                    onChange={(e) => setImageN(Math.max(1, Math.min(4, Number(e.target.value) || 1)))}
                    className="w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-[12px] text-ink outline-none focus:border-brand/60"
                  />
                </div>
              </>
            )}

            {endpoint === "video" && (
              <>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-muted">尺寸</label>
                  <Select value={videoSize} onChange={(e) => setVideoSize(e.target.value)} className="w-full">
                    {["1280x720", "720x1280", "1024x1024"].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-muted">时长（秒）</label>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={videoSeconds}
                    onChange={(e) => setVideoSeconds(String(Math.max(1, Math.min(60, Number(e.target.value) || 5))))}
                    className="w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-[12px] text-ink outline-none focus:border-brand/60"
                  />
                </div>
              </>
            )}
          </div>
        </Card>

        {/* 消息区 */}
        <Card className="flex min-h-[520px] flex-col overflow-hidden">
          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-4">
            {msgs.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
                <FlaskConical size={30} className="text-muted" />
                <p className="text-[13px] text-muted">
                  {endpoint === "chat" ? "选个模型，随便问点什么" : `试试${ENDPOINTS.find((e) => e.key === endpoint)?.label}生成`}
                </p>
                <p className="text-[11px] text-muted">Enter 发送 · Shift + Enter 换行</p>
              </div>
            ) : (
              msgs.map((m) => (
                <div key={m.id} className={cn("flex gap-2.5", m.role === "user" && "flex-row-reverse")}>
                  <div
                    className={cn(
                      "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                      m.role === "user" ? "bg-brand/15 text-brand" : "bg-surface2 text-muted"
                    )}
                  >
                    {m.role === "user" ? <User size={14} /> : (() => { const I = ENDPOINTS.find((e) => e.key === m.endpoint)?.icon; return I ? <I size={14} /> : null; })()}
                  </div>
                  <div className={cn("max-w-[85%] space-y-1", m.role === "user" && "text-right")}>
                    <div
                      className={cn(
                        "inline-block whitespace-pre-wrap break-words rounded-xl2 px-3.5 py-2.5 text-left text-[13px] leading-relaxed",
                        m.role === "user" ? "bg-brand text-white" : "bg-surface2 text-ink"
                      )}
                    >
                      {m.mediaMime === "image" && m.mediaUrl && (
                        <img src={m.mediaUrl} alt="生成结果" className="max-h-80 rounded-lg border border-line" />
                      )}
                      {m.mediaMime === "video" && m.mediaUrl && (
                        <video src={m.mediaUrl} controls className="max-h-80 rounded-lg border border-line" />
                      )}
                      {m.mediaMime === "audio" && m.mediaUrl && (
                        <audio src={m.mediaUrl} controls className="w-72" />
                      )}
                      {m.content && <span>{m.content || (busy ? "…" : "")}</span>}
                      {m.taskId && (
                        <span className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                          任务 {m.taskId.slice(0, 14)}…
                          <span className={cn(
                            "rounded px-1 py-0.5 text-[10px]",
                            m.taskStatus === "completed" ? "bg-emerald-500/10 text-emerald-500"
                            : m.taskStatus === "failed" || m.taskStatus === "cancelled" ? "bg-red-500/10 text-red-500"
                            : "bg-amber-500/10 text-amber-500"
                          )}>
                            {m.taskWaitingSlot ? "待提交" : m.taskStatus === "in_progress" ? "生成中" : m.taskStatus === "queued" ? "排队中" : m.taskStatus}
                          </span>
                          {typeof m.taskProgress === "number" && m.taskProgress > 0 && m.taskStatus !== "completed" && (
                            <span className="font-mono">{Math.round(m.taskProgress)}%</span>
                          )}
                        </span>
                      )}
                      {m.error && <span className="mt-1 block text-[11px] text-err">{m.error}</span>}
                    </div>
                    <div className={cn("flex items-center gap-2 text-[10px] text-muted", m.role === "user" && "justify-end")}>
                      {m.role === "assistant" && m.model && <span>{m.model}</span>}
                      {m.role === "assistant" && m.tokens ? <span>{m.tokens} tokens</span> : null}
                      {m.content && (
                        <button type="button" className="hover:text-ink" onClick={() => copy(m.content)}>
                          <Copy size={10} className="mr-0.5 inline" />复制
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="border-t border-line p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={2}
                placeholder={inputPlaceholder}
                className="max-h-40 min-h-[46px] flex-1 resize-y rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-brand/60"
              />
              {busy && endpoint === "chat" ? (
                <Button variant="danger" className="h-11" onClick={stop}>
                  <Square size={14} /> 停止
                </Button>
              ) : (
                <Button
                  className="h-11"
                  onClick={send}
                  disabled={!input.trim() || !keyId || busy || videoRunning || (needModel && !model)}
                >
                  <Send size={14} /> {sendLabel}
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
