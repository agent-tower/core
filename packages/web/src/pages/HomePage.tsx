import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function HomePage() {
  return (
    <div className="container mx-auto p-8">
      <h1 className="text-4xl font-bold mb-8">Agent Tower</h1>
      <p className="text-muted-foreground mb-8">AI Agent 任务管理面板</p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>项目管理</CardTitle>
            <CardDescription>管理你的 AI Agent 项目</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full">查看项目</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>任务看板</CardTitle>
            <CardDescription>Kanban 风格的任务管理</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" variant="secondary">打开看板</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>工作区</CardTitle>
            <CardDescription>Git Worktree 隔离环境</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" variant="outline">管理工作区</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
