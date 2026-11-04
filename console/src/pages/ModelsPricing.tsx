import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { Me } from "../lib/api";
import ModelPool from "./ModelPool";
import Pricing from "./Pricing";

type Tab = "models" | "pricing";

/** 模型与定价：模型池 + 定价合并入口，使用与「用户与组织」一致的选项卡布局。 */
export default function ModelsPricing() {
  const { me } = useOutletContext<{ me: Me }>();
  const canPricing = me.user.role === "superadmin";
  const [tab, setTab] = useState<Tab>("models");

  const TABS = (canPricing
    ? ([["models", "模型池"], ["pricing", "定价"]] as const)
    : ([["models", "模型池"]] as const));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex w-full gap-1 overflow-x-auto rounded-lg bg-surface2 p-0.5 sm:w-fit" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k as Tab)}
            className={`rounded-md px-4 py-1.5 text-xs font-medium transition-colors ${tab === k ? "bg-surface text-brand shadow-sm" : "text-muted hover:text-ink"}`}>{l}</button>
        ))}
      </div>

      {tab === "models" && <ModelPool me={me} />}
      {tab === "pricing" && canPricing && <Pricing me={me} />}
    </div>
  );
}
