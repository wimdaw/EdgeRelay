import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Globe } from "lucide-react";
import { LOCALE_OPTIONS, applyLocaleDom, setLocale, useLocaleSync, type Locale } from "../lib/i18n";
import { cn } from "../lib/utils";

/**
 * 语言切换下拉（全站共用）：控制台顶栏 / 登录注册页 / 官网首页通用。
 * compact：移动端只显示 Globe 图标（省空间），sm 起显示当前语言代码与箭头。
 * 选中即时生效：setLocale 触发 React 重渲染，applyLocaleDom 挂 DOM 转换层（繁体/英文覆盖）。
 */
export default function LocaleMenu({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  // 下拉对齐方向：打开时按按钮位置测量。桌面顶栏（按钮靠右）→ 右对齐向下展开；
  // 移动端展开菜单里按钮在行首，右对齐会让 144px 宽的下拉溢出视口左缘（错位）→ 左对齐。
  const [align, setAlign] = useState<"left" | "right">("right");
  const locale = useLocaleSync();
  const box = useRef<HTMLDivElement>(null);
  const MENU_WIDTH = 144; // 与下方 w-36 一致

  const toggle = () => {
    setOpen((v) => {
      if (!v) {
        // 优先保持右对齐（桌面顶栏原行为）；右对齐会让菜单左缘溢出视口时才改左对齐
        const rect = box.current?.getBoundingClientRect();
        if (rect) {
          const PAD = 8;
          const rightFits = rect.right - MENU_WIDTH >= PAD;
          const leftFits = rect.left + MENU_WIDTH <= window.innerWidth - PAD;
          setAlign(rightFits || !leftFits ? "right" : "left");
        }
      }
      return !v;
    });
  };

  // 点击面板/按钮以外区域或按 Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (next: Locale) => {
    setLocale(next);
    applyLocaleDom(next);
    setOpen(false);
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label="切换语言"
        aria-haspopup="menu"
        aria-expanded={open}
        title="切换语言"
        className={cn(
          "inline-flex items-center gap-1 rounded-lg text-muted transition-colors hover:bg-surface2 hover:text-ink",
          compact ? "p-1.5 sm:p-2" : "p-2"
        )}
      >
        <Globe size={16} />
        <span className={cn("text-[11px] font-medium", compact && "hidden sm:inline")}>{locale}</span>
        <ChevronDown size={12} className={cn("hidden transition-transform sm:block", open && "rotate-180")} />
      </button>
      {open && (
        <div
          role="menu"
          /* 语言名永远显示原生写法（简体中文/繁體中文/English），打上免疫标记避免 zh-TW/en-US DOM 转换层改写 */
          data-s2t-done="1"
          data-i18n-done="1"
          className={cn(
            "absolute top-full z-50 mt-1.5 w-36 overflow-hidden rounded-xl2 border border-line bg-surface py-1 shadow-pop",
            align === "left" ? "left-0" : "right-0"
          )}
        >
          {LOCALE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitem"
              onClick={() => pick(o.value)}
              className={cn(
                "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-surface2",
                locale === o.value ? "font-semibold text-brand" : "text-ink"
              )}
            >
              {o.label}
              {locale === o.value && <Check size={14} className="shrink-0 text-brand" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
