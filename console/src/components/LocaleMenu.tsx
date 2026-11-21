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
  const locale = useLocaleSync();
  const box = useRef<HTMLDivElement>(null);

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
        onClick={() => setOpen((v) => !v)}
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
          className="absolute right-0 top-full z-50 mt-1.5 w-36 overflow-hidden rounded-xl2 border border-line bg-surface py-1 shadow-pop"
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
