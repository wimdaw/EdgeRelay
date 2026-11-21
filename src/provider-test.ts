/**
 * 供应商连通性测试（用户提交审核流 / 管理员审核共用）
 *  - openai_compat：GET {base}/models（404 自动回退 {base}/v1/models），Bearer 或 x-api-key
 *  - anthropic：    GET {base}/v1/models，x-api-key + anthropic-version
 *  - 成功判定：HTTP 2xx；返回延迟与模型目录数量（仅参考，不落库）
 *  - 鉴权失败（401/403）直接返回，不回退候选路径——说明网络可达、密钥有问题
 */
export type ConnectivityResult = {
  ok: boolean;
  status: number;
  latencyMs: number;
  message: string;
  modelCount?: number;
};

export async function testUpstreamConnectivity(
  opts: { baseUrl: string; kind: string; authScheme: string; key: string },
  timeoutMs = 15000
): Promise<ConnectivityResult> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const key = opts.key || "";
  const isAnthropic = opts.kind === "anthropic";
  const authHeaders: Record<string, string> = isAnthropic
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : opts.authScheme === "x-api-key"
    ? { "x-api-key": key }
    : { authorization: `Bearer ${key}` };

  const candidates = isAnthropic ? [`${base}/v1/models`] : [`${base}/models`, `${base}/v1/models`];
  let last: ConnectivityResult | null = null;

  for (const url of candidates) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: { ...authHeaders, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = Date.now() - started;
      const text = await res.text().catch(() => "");

      let modelCount: number | undefined;
      try {
        const j = JSON.parse(text);
        if (Array.isArray(j?.data)) modelCount = j.data.length;
        else if (Array.isArray(j?.models)) modelCount = j.models.length;
      } catch {}

      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          latencyMs,
          message: `连通正常（HTTP ${res.status}，${latencyMs}ms${modelCount != null ? `，目录 ${modelCount} 个模型` : ""}）`,
          modelCount,
        };
      }
      last = {
        ok: false,
        status: res.status,
        latencyMs,
        message: res.status === 401 || res.status === 403 ? `鉴权失败（HTTP ${res.status}）：密钥无效或无权限` : `上游返回 HTTP ${res.status}: ${text.slice(0, 120)}`,
      };
      // 404 可回退下一候选路径；其他状态码（含 401/403 鉴权失败）直接定论
      if (!(res.status === 404 && candidates.length > 1 && url === candidates[0])) return last;
    } catch (e: any) {
      const latencyMs = Date.now() - started;
      last = { ok: false, status: 0, latencyMs, message: `无法连接上游：${e?.message || "网络异常"}` };
      // 网络层失败且还有候选路径时继续尝试
      if (!(candidates.length > 1 && url === candidates[0])) return last;
    }
  }
  return last || { ok: false, status: 0, latencyMs: 0, message: "无法连接上游" };
}
