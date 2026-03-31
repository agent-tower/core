import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useI18n } from '@/lib/i18n'

export function HomePage() {
  const { t } = useI18n()

  return (
    <div className="container mx-auto p-8">
      <h1 className="text-4xl font-bold mb-8">Agent Tower</h1>
      <p className="text-muted-foreground mb-8">{t('AI Agent Task Management Dashboard')}</p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('Project Management')}</CardTitle>
            <CardDescription>{t('Manage your AI agent projects')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full">{t('View Projects')}</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('Task Board')}</CardTitle>
            <CardDescription>{t('Kanban-style task management')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" variant="secondary">{t('Open Board')}</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('Workspace')}</CardTitle>
            <CardDescription>{t('Git worktree isolated environments')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" variant="outline">{t('Manage Workspaces')}</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
