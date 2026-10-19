import { ArrowRight } from 'lucide-react'

const BRANCH_CHIP = 'h-6 min-w-0 truncate rounded-md bg-foreground/[0.05] px-2 font-mono text-xs leading-6 text-foreground/85'

/** 源分支 → 目标分支：提交、合并弹窗的抬头（分支名太长时截断，悬停看全名） */
export function BranchFlow({ from, to }: { from: string; to: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span title={from} className={BRANCH_CHIP}>{from}</span>
      <ArrowRight size={14} className="shrink-0 text-muted-foreground/70" />
      <span title={to} className={BRANCH_CHIP}>{to}</span>
    </div>
  )
}
