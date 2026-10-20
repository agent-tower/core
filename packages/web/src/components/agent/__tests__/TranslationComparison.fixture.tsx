import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n'
import { queryKeys } from '@/hooks/query-keys'
import { CopyTranslationText, TranslationComparison } from '../TranslationComparison'
import '@/index.css'

// A component-only fixture: no Session, API, database or Provider is started.
const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
client.setQueryData(queryKeys.appSettings.detail, { locale: 'zh-CN' })
const original = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: Original text for keyboard and touch scrolling.\n\n`).join('')

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}><I18nProvider>
    <main className="mx-auto max-w-3xl space-y-10 p-6">
      <h1>Translation comparison interaction fixture</h1>
      {['task', 'conversation'].map(name => <section key={name} data-case={name} className="space-y-4">
        <h2>{name}</h2>
        <button type="button" data-before className="rounded border p-2">Before {name}</button>
        <p>译文正文</p>
        <div className="flex items-center gap-2">
          <TranslationComparison original={original}><p className="whitespace-pre-wrap">{original}</p></TranslationComparison>
          <CopyTranslationText text="译文正文" label="复制当前正文" />
        </div>
        <button type="button" data-after className="rounded border p-2">After {name}</button>
      </section>)}
    </main>
  </I18nProvider></QueryClientProvider>,
)
