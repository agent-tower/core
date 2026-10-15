/** 展示页目录：顺序即页面顺序，编号由下标生成 */
export interface ShowcaseSectionMeta {
  id: string
  title: string
  en: string
}

export interface ShowcaseSectionGroup {
  title: string
  sections: ShowcaseSectionMeta[]
}

export const SECTION_GROUPS: ShowcaseSectionGroup[] = [
  {
    title: '基础',
    sections: [
      { id: 'principles', title: '原则', en: 'Principles' },
      { id: 'color', title: '颜色', en: 'Color' },
      { id: 'typography', title: '文字', en: 'Typography' },
      { id: 'layout', title: '间距、圆角与层级', en: 'Space & Elevation' },
      { id: 'icons', title: '图标', en: 'Icons' },
      { id: 'agents', title: 'Agent 标志', en: 'Agent Logos' },
      { id: 'motion', title: '动效', en: 'Motion' },
    ],
  },
  {
    title: '组件',
    sections: [
      { id: 'status', title: '状态', en: 'Status' },
      { id: 'actions', title: '操作', en: 'Actions' },
      { id: 'inputs', title: '输入', en: 'Inputs' },
      { id: 'overlays', title: '浮层', en: 'Overlays' },
      { id: 'navigation', title: '导航', en: 'Navigation' },
      { id: 'business', title: '业务组件', en: 'Agent Tower' },
    ],
  },
  {
    title: '展示组件',
    sections: [
      { id: 'viz-principles', title: '展示原则', en: 'Display Principles' },
      { id: 'marks', title: '画法', en: 'Marks' },
      { id: 'goals', title: '目标', en: 'Goals' },
      { id: 'numbers', title: '数字', en: 'Numbers' },
      { id: 'trends', title: '趋势与对比', en: 'Trend & Comparison' },
      { id: 'composition', title: '构成与分布', en: 'Composition' },
      { id: 'lists', title: '清单', en: 'Lists' },
      { id: 'tables', title: '表格', en: 'Tables' },
      { id: 'schedule', title: '流程与排期', en: 'Process & Schedule' },
      { id: 'people', title: '人与内容', en: 'People & Content' },
    ],
  },
]

export const SECTIONS = SECTION_GROUPS.flatMap(group => group.sections)

export function sectionNumber(id: string) {
  return String(SECTIONS.findIndex(section => section.id === id) + 1).padStart(2, '0')
}
