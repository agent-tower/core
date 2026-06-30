import { AgentCliEnvironmentPanel } from '@/components/agent-cli/AgentCliEnvironmentPanel'
import {
  SettingsPageContainer,
  SettingsPageHeader,
} from '@/components/settings/SettingsSection'
import { useI18n } from '@/lib/i18n'

export function AgentEnvironmentSettingsPage() {
  const { t } = useI18n()

  return (
    <SettingsPageContainer>
      <SettingsPageHeader
        title={t('Agent 环境')}
        description={t('检测并安装本机 Agent CLI。安装前会展示官方来源、风险和校验摘要。')}
      />
      <AgentCliEnvironmentPanel />
    </SettingsPageContainer>
  )
}
