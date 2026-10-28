/**
 * 极简 SMTP 客户端（基于 Node.js 原生 node:tls，EdgeOne / Node 20 兼容）
 *  - 支持 465 隐式 TLS（网易 163、QQ 邮箱、企业邮标准端口）
 *  - AUTH LOGIN 标准身份认证
 *  - 全异步 Promise 事件驱动，带 20 秒超时机制
 */
import tls from "node:tls";

export type SmtpConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
};

const b64 = (s: string) => Buffer.from(s).toString("base64");

export async function sendMail(
  cfg: SmtpConfig,
  mail: { to: string; subject: string; text: string; html?: string }
): Promise<void> {
  const host = cfg.host.trim();
  const port = cfg.port || 465;
  const user = cfg.username.includes("@") ? cfg.username : cfg.from || cfg.username;
  const pass = cfg.password;
  const from = cfg.from || user;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`SMTP 发信超时（${host}:${port}）。请检查网络或邮件服务器配置。`));
    }, 20000);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket.destroy();
      } catch {}
    };

    const fail = (msg: string) => {
      cleanup();
      reject(new Error(msg));
    };

    let socket: tls.TLSSocket;
    try {
      socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        // 连接成功，等待 220 握手
      });
    } catch (e: any) {
      clearTimeout(timeout);
      return reject(new Error(`无法建立 TLS 连接到 ${host}:${port}: ${e?.message}`));
    }

    socket.setTimeout(20000);
    socket.on("timeout", () => fail(`SMTP 连接超时（${host}:${port}）`));
    socket.on("error", (err) => fail(`SMTP Socket 错误: ${err.message}`));

    let step = 0;
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const code = parseInt(line.slice(0, 3), 10);
        if (isNaN(code)) continue;

        // 阶段 0: 收到 220 Greeting
        if (step === 0 && code === 220) {
          step = 1;
          socket.write("EHLO edgerelay\r\n");
        }
        // 阶段 1: 收到 250 EHLO 响应
        else if (step === 1 && code === 250) {
          // 如果是多行响应 250-，继续等待最后一行 250
          if (line.startsWith("250 ")) {
            step = 2;
            socket.write("AUTH LOGIN\r\n");
          }
        }
        // 阶段 2: 收到 334 要求输入用户名
        else if (step === 2 && code === 334) {
          step = 3;
          socket.write(b64(user) + "\r\n");
        }
        // 阶段 3: 收到 334 要求输入密码
        else if (step === 3 && code === 334) {
          step = 4;
          socket.write(b64(pass) + "\r\n");
        }
        // 阶段 4: 收到 235 认证成功
        else if (step === 4 && code === 235) {
          step = 5;
          socket.write(`MAIL FROM:<${from}>\r\n`);
        }
        // 阶段 5: 收到 250 MAIL FROM 成功
        else if (step === 5 && code === 250) {
          step = 6;
          socket.write(`RCPT TO:<${mail.to}>\r\n`);
        }
        // 阶段 6: 收到 250/251 RCPT TO 成功
        else if (step === 6 && (code === 250 || code === 251)) {
          step = 7;
          socket.write("DATA\r\n");
        }
        // 阶段 7: 收到 354 开始传输邮件内容
        else if (step === 7 && code === 354) {
          step = 8;
          const boundary = `----=_EdgeRelay_${Date.now().toString(36)}`;
          const subjectEncoded = `=?UTF-8?B?${b64(mail.subject)}?=`;

          const headers = [
            `From: <${from}>`,
            `To: <${mail.to}>`,
            `Subject: ${subjectEncoded}`,
            `MIME-Version: 1.0`,
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
            `Date: ${new Date().toUTCString()}`,
            ``,
          ];

          const bodyParts = [
            `--${boundary}`,
            `Content-Type: text/plain; charset=UTF-8`,
            `Content-Transfer-Encoding: base64`,
            ``,
            b64(mail.text),
            ``,
          ];

          if (mail.html) {
            bodyParts.push(
              `--${boundary}`,
              `Content-Type: text/html; charset=UTF-8`,
              `Content-Transfer-Encoding: base64`,
              ``,
              b64(mail.html),
              ``
            );
          }

          bodyParts.push(`--${boundary}--`, ``, `.`);

          const fullMessage = headers.concat(bodyParts).join("\r\n") + "\r\n";
          socket.write(fullMessage);
        }
        // 阶段 8: 收到 250 发送完成
        else if (step === 8 && code === 250) {
          step = 9;
          socket.write("QUIT\r\n");
          cleanup();
          resolve();
          return;
        }
        // 错误状态码处理
        else if (code >= 400) {
          if (step === 4) {
            fail(`SMTP 认证失败（535/435）：请检查邮箱账号或授权码是否正确。服务器返回: ${line}`);
          } else {
            fail(`SMTP 错误 (阶段 ${step}): ${line}`);
          }
          return;
        }
      }
    });
  });
}
