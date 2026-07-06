import { useState } from 'react'
import { LockKeyhole, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAccessAuthStatus, useLoginAccessAuth } from '@/hooks/use-access-auth'
import { translate } from '@/lib/i18n'

function AccessLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <Loader2 size={18} className="animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
    </div>
  )
}

function UnlockView() {
  const [password, setPassword] = useState('')
  const login = useLoginAccessAuth()
  const error = login.isError ? translate('密码不正确，请重试') : null

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <form
        className="w-full max-w-sm space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          const value = password
          if (!value) return
          login.mutate(value)
        }}
      >
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <LockKeyhole size={18} aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Agent Tower</h1>
          <p className="text-sm text-muted-foreground">{translate('输入访问密码继续')}</p>
        </div>

        <div className="space-y-2">
          <Input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
              login.reset()
            }}
            aria-invalid={Boolean(error)}
            placeholder={translate('访问密码')}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <Button className="w-full" type="submit" disabled={!password || login.isPending}>
          {login.isPending && <Loader2 size={14} className="mr-2 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {login.isPending ? translate('验证中...') : translate('解锁')}
        </Button>
      </form>
    </div>
  )
}

export function AccessGate({ children }: { children: React.ReactNode }) {
  const { data, isLoading, isError } = useAccessAuthStatus()

  if (isLoading) return <AccessLoading />

  if (isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 text-sm text-muted-foreground">
        {translate('访问状态加载失败，请刷新后重试。')}
      </div>
    )
  }

  if (data?.enabled && !data.authenticated) {
    return <UnlockView />
  }

  return <>{children}</>
}
