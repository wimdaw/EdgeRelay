/**
 * 在线支付路由
 *
 * 协议：彩虹易支付（100% 兼容 submit.php / mapi.php / api.php）
 *  - 下单：把参数按 ASCII 升序拼成 k=v&...，末尾接商户 KEY 取 32 位小写 MD5 作为 sign
 *  - 回调：平台以 GET 回跳 notify_url，同样算法验签；验签通过必须只输出纯文本 success
 *  - 金额与商户号必须与本地订单/配置一致，避免伪造低价回调
 *
 * 订单存在 KV（TTL 48h），只记录业务所需字段，不落任何密钥。
 */
import { Hono } from "hono";
import type { Env, HandlerCtx } from "../types";
import { requireUser } from "../auth";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { getSettings, json } from "../settings";
import { getKV } from "../storage/blob-store";
import { decryptSecret } from "../crypto";
import { md5Hex } from "../md5";
import { getBalance, topup } from "../billing";

export const payRouter = new Hono<{ Bindings: Env }>();

const ORDER_PREFIX = "epay:order:";
/** 订单保留 48 小时，足够覆盖平台 24 小时内的 5 次重试 */
const ORDER_TTL = 48 * 3600;
const DEFAULT_CHANNELS = ["alipay", "wxpay", "qqpay"];

type OrderStatus = "pending" | "paid";

type OrderRecord = {
  outTradeNo: string;
  userId: string;
  email: string;
  amount: number;
  channel: string;
  status: OrderStatus;
  createdAt: number;
  paidAt?: number;
  tradeNo?: string;
};

/** 易支付签名：过滤 sign/sign_type 与空值 → ASCII 升序 → k=v& 拼接 → 末尾接 KEY → MD5 */
export function buildEpaySign(params: Record<string, string>, key: string): string {
  const query = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type")
    .filter((k) => {
      const v = params[k];
      return v !== undefined && v !== null && String(v) !== "";
    })
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return md5Hex(query + key);
}

async function readOrder(env: Env, outTradeNo: string): Promise<OrderRecord | null> {
  const raw = await getKV(env).get(ORDER_PREFIX + outTradeNo);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OrderRecord;
  } catch {
    return null;
  }
}

async function writeOrder(env: Env, order: OrderRecord): Promise<void> {
  await getKV(env).put(ORDER_PREFIX + order.outTradeNo, JSON.stringify(order), { expirationTtl: ORDER_TTL });
}

/** 纯文本响应：易支付只认 success / fail */
function text(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** 支付通道配置是否可用（网关 + 商户号 + 密钥齐全且已启用） */
export function epayReady(s: { epayEnabled?: boolean; epayGateway?: string; epayPid?: string; epayKeyEnc?: string }): boolean {
  return !!(s.epayEnabled && (s.epayGateway || "").trim() && (s.epayPid || "").trim() && s.epayKeyEnc);
}

function gatewayBase(raw?: string): string {
  return (raw || "").trim().replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ */
/* 下单                                                                */
/* ------------------------------------------------------------------ */

payRouter.post("/epay/create", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const s = await getSettings(c.env);
    if (!epayReady(s)) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "在线支付尚未启用或配置不完整，请联系管理员");
    }

    const body = await c.req.json<{ amount?: number | string; type?: string }>();
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "充值金额不合法");
    }
    // 金额统一按分取整，避免浮点误差带来 0.001 之类的脏值
    const money = Math.round(amount * 100) / 100;
    const min = Number(s.epayMinAmount ?? 1);
    const max = Number(s.epayMaxAmount ?? 5000);
    if (money < min || money > max) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, `单笔充值金额需在 ¥${min} ~ ¥${max} 之间`);
    }

    const channels = Array.isArray(s.epayChannels) && s.epayChannels.length ? s.epayChannels : DEFAULT_CHANNELS;
    const channel = String(body.type || channels[0]).trim();
    if (!channels.includes(channel)) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, `不支持的支付方式：${channel}`);
    }

    const key = await decryptSecret(c.env, s.epayKeyEnc!);
    const origin = new URL(c.req.url).origin;
    const outTradeNo = `R${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    // 先落单再下单：回调可能比响应先到，订单必须已存在
    const order: OrderRecord = {
      outTradeNo,
      userId: user.id,
      email: user.email,
      amount: money,
      channel,
      status: "pending",
      createdAt: Math.floor(Date.now() / 1000),
    };
    await writeOrder(c.env, order);

    const params: Record<string, string> = {
      pid: String(s.epayPid).trim(),
      type: channel,
      out_trade_no: outTradeNo,
      notify_url: `${origin}/api/pay/epay/notify`,
      return_url: `${origin}/dashboard?order=${outTradeNo}`,
      name: (s.epayProductName || "API 额度充值").slice(0, 60),
      money: money.toFixed(2),
    };
    params.sign = buildEpaySign(params, key);
    params.sign_type = "MD5";

    let data: any;
    try {
      const resp = await fetch(`${gatewayBase(s.epayGateway)}/mapi.php`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
      });
      const raw = await resp.text();
      try {
        data = JSON.parse(raw);
      } catch {
        throw new ApiError(502, ErrorCode.INTERNAL, `支付网关返回非 JSON：${raw.slice(0, 120)}`);
      }
    } catch (err) {
      // 下单失败要把悬挂订单清掉，否则会留下永远 pending 的单
      await getKV(c.env).delete(ORDER_PREFIX + outTradeNo).catch(() => {});
      if (err instanceof ApiError) throw err;
      throw new ApiError(502, ErrorCode.INTERNAL, `支付网关不可达：${(err as Error).message}`);
    }

    if (Number(data?.code) !== 1) {
      await getKV(c.env).delete(ORDER_PREFIX + outTradeNo).catch(() => {});
      throw new ApiError(502, ErrorCode.INTERNAL, data?.msg ? `下单失败：${data.msg}` : "下单失败");
    }

    return json({
      ok: true,
      outTradeNo,
      amount: money,
      channel,
      payUrl: data.payurl || data.pay_url || "",
      qrCode: data.qrcode || data.qr_code || "",
      tradeNo: data.trade_no || "",
    });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/* ------------------------------------------------------------------ */
/* 异步回调                                                            */
/* ------------------------------------------------------------------ */

payRouter.get("/epay/notify", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const s = await getSettings(c.env);
    if (!s.epayKeyEnc) return text("fail");

    const query: Record<string, string> = {};
    new URL(c.req.url).searchParams.forEach((v, k) => {
      query[k] = v;
    });

    const key = await decryptSecret(c.env, s.epayKeyEnc);
    const sign = String(query.sign || "").toLowerCase();
    if (!sign || sign !== buildEpaySign(query, key)) return text("fail");

    // 商户号必须与本站一致，防止别家商户的回调被串进来
    if (s.epayPid && String(query.pid || "") !== String(s.epayPid)) return text("fail");
    if (query.trade_status !== "TRADE_SUCCESS") return text("fail");

    const outTradeNo = String(query.out_trade_no || "");
    if (!outTradeNo) return text("fail");
    const order = await readOrder(c.env, outTradeNo);
    if (!order) return text("fail");

    // 金额只认平台实付且不能低于订单金额；宁可变少也不放大
    const paid = Number(query.money);
    if (!Number.isFinite(paid) || paid + 1e-6 < order.amount) return text("fail");

    // 幂等：已入账直接回 success，避免平台重试导致重复加款
    if (order.status === "paid") return text("success");

    // 先抢占再入账：并发重试时后到的一笔会读到 paid 而直接返回，
    // 入账失败则回滚成 pending 让平台重试可以继续
    await writeOrder(c.env, { ...order, status: "paid", paidAt: Math.floor(Date.now() / 1000), tradeNo: String(query.trade_no || "") });
    try {
      await topup(
        hCtx,
        `user:${order.userId}`,
        order.amount,
        `易支付充值 ${order.outTradeNo}（平台单号 ${String(query.trade_no || "-")}）`
      );
    } catch (err) {
      await writeOrder(c.env, order).catch(() => {});
      return text("fail");
    }

    // 余额 > 0 自动升 VIP，与卡密兑换保持一致
    try {
      const bal = await getBalance(c.env, `user:${order.userId}`);
      const { syncUserVipStatus } = await import("../storage/db");
      await syncUserVipStatus(c.env, order.userId, bal.available);
    } catch {
      /* 升级失败不影响到账 */
    }

    return text("success");
  } catch (err) {
    // 回调失败要留痕，否则平台侧只会看到 fail，排查无从下手
    console.error("[epay] notify 处理失败:", (err as Error)?.message || err);
    return text("fail");
  }
});

/* ------------------------------------------------------------------ */
/* 订单查询（前端轮询）                                                 */
/* ------------------------------------------------------------------ */

payRouter.get("/epay/order/:outTradeNo", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const outTradeNo = c.req.param("outTradeNo");
    const order = await readOrder(c.env, outTradeNo);
    // 不区分「不存在」与「不属于你」，避免探测他人订单号
    if (!order || order.userId !== user.id) {
      throw new ApiError(404, ErrorCode.NOT_FOUND, "订单不存在");
    }
    return json({
      ok: true,
      order: {
        outTradeNo: order.outTradeNo,
        amount: order.amount,
        channel: order.channel,
        status: order.status,
        createdAt: order.createdAt,
        paidAt: order.paidAt ?? null,
      },
    });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
