import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerMessages, applyLocaleDom, getLocale, registerEnPhrases } from "./lib/i18n";
import enPhrases from "./locales/en-phrases";
import zhCN from "./locales/zh-CN";
import zhTW from "./locales/zh-TW";
import enUS from "./locales/en-US";

registerMessages("zh-CN", zhCN);
registerMessages("zh-TW", zhTW);
registerMessages("en-US", enUS);
registerEnPhrases(enPhrases);

// 启动即按当前语言挂载 DOM 转换层：zh-TW 会话刷新/直达时繁体化不失效
requestAnimationFrame(() => applyLocaleDom(getLocale()));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
