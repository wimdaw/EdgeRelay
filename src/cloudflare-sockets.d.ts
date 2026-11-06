// 最小声明：仅在 Workers 运行时存在，用于类型检查；非 Workers 环境由 try/catch 回退 Node 实现。
declare module 'cloudflare:sockets' {
  // 返回类型用 any，仅用于通过类型检查；实际调用处已声明精确的 ConnectFn 契约
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function connect(address: any, options?: any): any;
}
