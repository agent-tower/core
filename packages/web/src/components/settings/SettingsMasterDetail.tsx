import { ArrowLeft } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * 设置页通用 Master-Detail 布局
 *
 * 左侧：列表（独立滚动）
 * 右侧：详情面板（独立滚动）
 * 移动端：列表/详情切换
 *
 * 适用场景：Provider、Project 等「选中查看详情」的设置页
 */

interface SettingsMasterDetailProps<T> {
  /** 列表数据 */
  items: T[]
  /** 当前选中项 ID */
  selectedId: string | null
  /** 选中事件 */
  onSelectItem: (id: string) => void
  /** 获取项的 ID */
  getItemId: (item: T) => string

  /** 渲染列表项（返回完整的按钮内容） */
  renderListItem: (item: T, isActive: boolean) => React.ReactNode
  /** 渲染详情面板（item 为 null 时显示空状态提示） */
  renderDetail: (item: T | null) => React.ReactNode

  /** 列表底部追加区域（可选，如 Project 的"已删除"区） */
  renderListFooter?: () => React.ReactNode

  /** 移动端是否显示详情（由父组件管理状态） */
  mobileShowDetail: boolean
  /** 移动端返回列表回调 */
  onMobileBack: () => void

  /** 列表容器自定义样式 */
  listClassName?: string
  /** 详情容器自定义样式 */
  detailClassName?: string
}

export function SettingsMasterDetail<T>({
  items,
  selectedId,
  onSelectItem,
  getItemId,
  renderListItem,
  renderDetail,
  renderListFooter,
  mobileShowDetail,
  onMobileBack,
  listClassName,
  detailClassName,
}: SettingsMasterDetailProps<T>) {
  const { t } = useI18n()

  const selectedItem = items.find(item => getItemId(item) === selectedId) ?? null

  return (
    <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)] lg:h-[calc(100vh-16rem)] lg:max-h-[640px]">
      {/* List sidebar — independent scroll */}
      <div
        className={cn(
          'space-y-1 lg:overflow-y-auto lg:pr-1 scrollbar-app-thin',
          mobileShowDetail && 'hidden lg:block',
          listClassName,
        )}
      >
        {items.map(item => {
          const id = getItemId(item)
          const isActive = id === selectedId
          return (
            <button
              key={id}
              onClick={() => onSelectItem(id)}
              aria-current={isActive ? 'true' : undefined}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-foreground hover:bg-muted/50',
              )}
            >
              {renderListItem(item, isActive)}
            </button>
          )
        })}

        {renderListFooter?.()}
      </div>

      {/* Detail panel — independent scroll */}
      <div
        className={cn(
          'rounded-xl border border-border bg-card lg:overflow-y-auto scrollbar-app-thin',
          !mobileShowDetail && 'hidden lg:block',
          detailClassName,
        )}
      >
        {/* Mobile back button */}
        <button
          onClick={onMobileBack}
          className="mb-4 flex items-center gap-1.5 px-5 pt-3 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 lg:hidden"
        >
          <ArrowLeft size={14} />
          {t('返回列表')}
        </button>

        {renderDetail(selectedItem)}
      </div>
    </div>
  )
}
