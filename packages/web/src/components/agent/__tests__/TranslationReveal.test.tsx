// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Streamdown } from 'streamdown'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TranslationReveal } from '../TranslationComparison'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Call = { text: string | null; keyframes: Keyframe[]; options: KeyframeAnimationOptions }
let calls: Call[]
let root: Root
let host: HTMLDivElement
const content = () => calls.filter(call => 'opacity' in call.keyframes[0])
const heights = () => calls.filter(call => 'height' in call.keyframes[0]).map(call => call.keyframes)

// happy-dom delivers mutation records on a timer; browsers do it before the next task.
async function step(node: React.ReactNode) {
  await act(async () => root.render(node))
  await act(() => new Promise(resolve => setTimeout(resolve, 10)))
}

function Blocks({ texts }: { texts: string[] }) {
  return <div className="blocks">{texts.map((text, index) => <p key={index}>{text}</p>)}</div>
}

beforeEach(() => {
  calls = []
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    calls.push({ text: this.textContent, keyframes, options })
    return { cancel: vi.fn() }
  } })
  // One pixel per character keeps outgoing and incoming heights distinguishable.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { height: this.textContent?.length ?? 0 } as DOMRect
  })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.restoreAllMocks()
  delete (Element.prototype as { animate?: unknown }).animate
})

it('starts on the translated paragraph once Streamdown commits it, leaving the growing tail alone', async () => {
  const view = (version: string | null, text: string) => <TranslationReveal version={version} claim={() => true} blocks=".body">
    <Streamdown className="body">{text}</Streamdown>
  </TranslationReveal>
  await step(view(null, 'First original paragraph.\n\nTail'))
  await step(view('p0:1', '第一段。\n\nTail grows'))
  expect(calls.map(call => call.text)).toEqual(['第一段。', '第一段。'])
  expect(content()[0].keyframes).toEqual([
    { opacity: 0, transform: 'translateY(4px)', filter: 'blur(2px)' },
    { opacity: 1, transform: 'none', filter: 'none' },
  ])
  expect(heights()).toEqual([[{ height: '25px' }, { height: '4px' }]])
})

it('plays a remounted body block by block from the outgoing heights', async () => {
  const view = (version: string | null) => <TranslationReveal version={version} claim={() => true} blocks=".blocks">
    {version ? <Blocks key="translated" texts={['甲乙丙丁戊己庚辛', 'Short']} /> : <Blocks key="original" texts={['One', 'Two']} />}
  </TranslationReveal>
  await step(view(null))
  await step(view('message:1'))
  expect(content().map(call => [call.text, call.options.delay])).toEqual([['甲乙丙丁戊己庚辛', 0], ['Short', 30]])
  expect(heights()).toEqual([
    [{ height: '3px', clipPath: 'inset(0)' }, { height: '8px', clipPath: 'inset(0)' }],
    [{ height: '3px', clipPath: 'inset(0)' }, { height: '5px', clipPath: 'inset(0)' }],
  ])
})

it('stays still for an unclaimed version and its later restoration', async () => {
  const claimed = new Set<string>()
  const claim = (version: string) => !claimed.has(version) && Boolean(claimed.add(version)) && version.startsWith('live')
  const view = (version: string | null, texts: string[]) => <TranslationReveal version={version} claim={claim} blocks=".blocks"><Blocks texts={texts} /></TranslationReveal>
  await step(view(null, ['Original']))
  await step(view('history:1', ['译文']))
  await step(view(null, ['Original']))
  await step(view('live:1', ['新译文']))
  expect(content().map(call => call.text)).toEqual(['新译文'])
  await step(view(null, ['Original']))
  await step(view('live:1', ['新译文']))
  await step(view('history:1', ['译文']))
  expect(content().map(call => call.text)).toEqual(['新译文'])
})

it('neither observes nor plays without a claim, as when translation is off', async () => {
  const view = (version: string | null, texts: string[]) => <TranslationReveal version={version} blocks=".blocks"><Blocks texts={texts} /></TranslationReveal>
  await step(view(null, ['Original']))
  await step(view('live:1', ['译文']))
  expect(calls).toEqual([])
  expect(HTMLElement.prototype.getBoundingClientRect).not.toHaveBeenCalled()
})
