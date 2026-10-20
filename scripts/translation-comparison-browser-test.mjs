// Connect to an isolated Vite fixture and Chrome started by workspace services.
// No process is launched here. All focus transitions use trusted CDP input.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const [origin = 'http://127.0.0.1:53461', debugging = 'http://127.0.0.1:53462', output = 'output/translation-comparison-focus/browser'] = process.argv.slice(2)
for (const endpoint of [origin, debugging]) {
  const url = new URL(endpoint)
  assert.equal(url.protocol, 'http:')
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Only local fixtures are allowed')
}
await mkdir(output, { recursive: true })
const fixture = `${origin}/src/components/agent/__tests__/translation-comparison.fixture.html`
const target = await (await fetch(`${debugging}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let nextId = 0
const pending = new Map()
const exceptions = []
const requests = []
socket.onmessage = event => {
  const message = JSON.parse(String(event.data))
  if (message.id) {
    const job = pending.get(message.id)
    if (!job) return
    pending.delete(message.id)
    clearTimeout(job.timer)
    if (message.error) job.reject(new Error(message.error.message))
    else job.resolve(message.result)
  }
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
  if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 8000)
  pending.set(id, { resolve, reject, timer })
  socket.send(JSON.stringify({ id, method, params }))
})
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
async function waitFor(expression) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await pause(40)
  }
  throw new Error(`Timed out: ${expression}`)
}
async function key(key, shift = false) {
  const code = { Tab: 9, Escape: 27, ArrowDown: 40 }[key]
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0 })
}
async function point(selector) {
  return evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest'}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
}
async function mouse(type, position, extra = {}) {
  await send('Input.dispatchMouseEvent', { type, ...position, ...extra })
}
async function click(selector) {
  const position = await point(selector)
  await mouse('mouseMoved', position)
  await mouse('mousePressed', position, { button: 'left', clickCount: 1 })
  await mouse('mouseReleased', position, { button: 'left', clickCount: 1 })
}
async function touch(selector) {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [await point(selector)] })
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}
const triggerSelector = name => `[data-case="${name}"] button[aria-haspopup="dialog"]`
async function load(name, width = 1440) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1, mobile: width === 390 })
  await send('Page.navigate', { url: fixture })
  await waitFor('document.querySelectorAll("button[aria-haspopup=dialog]").length === 2')
  await evaluate(`(() => {
    window.probeTrigger = document.querySelector(${JSON.stringify(triggerSelector(name))});
    window.probeEvents = [];
    const record = (kind, extra) => window.probeEvents.push({kind,time:performance.now(),...extra});
    document.addEventListener('focusin', e => record('focusin',{trusted:e.isTrusted,target:e.target.getAttribute('aria-label') || e.target.textContent,expanded:window.probeTrigger.getAttribute('aria-expanded')}));
    document.addEventListener('dismissableLayer.focusOutside', e => queueMicrotask(() => record('focusOutside',{targetIsTrigger:e.target===window.probeTrigger,prevented:e.defaultPrevented,trusted:e.detail.originalEvent.isTrusted})),true);
    new MutationObserver(() => record('expanded',{value:window.probeTrigger.getAttribute('aria-expanded')})).observe(window.probeTrigger,{attributes:true,attributeFilter:['aria-expanded']});
  })()`)
}
async function state() {
  return evaluate(`({expanded:window.probeTrigger.getAttribute('aria-expanded'),activeIsTrigger:document.activeElement===window.probeTrigger,active:document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent,dialogs:document.querySelectorAll('[role=dialog]').length,events:window.probeEvents})`)
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(output, `${name}.png`), Buffer.from(data, 'base64'))
}
const results = []
async function check(name, run) {
  try { await run(); results.push({ name, passed: true }) }
  catch (error) { results.push({ name, passed: false, error: error.stack, state: await state() }); await screenshot(`${name}-failure`) }
}
try {
  await send('Runtime.enable')
  await send('Network.enable')
  for (const name of ['task', 'conversation']) {
    for (const reverse of [false, true]) {
      const label = `${name}-${reverse ? 'shift-tab' : 'tab'}`
      await check(label, async () => {
        await load(name)
        await click(`[data-case="${name}"] [${reverse ? 'data-after' : 'data-before'}]`)
        await mouse('mouseMoved', { x: 4, y: 4 })
        if (reverse) await key('Tab', true) // displayed-copy control precedes the outside button
        await key('Tab', reverse)
        await pause(400) // includes the component's 250 ms delayed close
        const focused = await state()
        await writeFile(path.join(output, `${label}-focus.json`), JSON.stringify(focused, null, 2))
        assert.ok(focused.activeIsTrigger, 'Tab must focus the original button')
        assert.equal(focused.expanded, 'true', 'Focus alone must keep the comparison open')
        assert.equal(focused.dialogs, 1)
        assert.ok(focused.events.some(e => e.kind === 'focusin' && e.trusted && e.target === '原文'))
        await screenshot(label)
        await key('Tab', true)
        await pause(300)
        assert.equal((await state()).expanded, 'false', 'Real outside focus must dismiss')
        await key('Tab')
        await pause(300)
        assert.equal((await state()).expanded, 'true', 'A new focus entry must reopen')
        await key(reverse ? 'ArrowDown' : 'Tab')
        assert.equal((await state()).active, '复制原文')
        await key('Escape')
        await pause(400)
        const escaped = await state()
        assert.ok(escaped.activeIsTrigger, 'Escape must restore trigger focus')
        assert.equal(escaped.expanded, 'false', 'Returned focus must not reopen')
        assert.equal(escaped.dialogs, 0)
        await writeFile(path.join(output, `${label}-lifecycle.json`), JSON.stringify(escaped, null, 2))
      })
    }
    await check(`${name}-mouse`, async () => {
      await load(name)
      await mouse('mouseMoved', await point(triggerSelector(name)))
      await waitFor('!!document.querySelector("[role=dialog]")')
      await mouse('mouseMoved', await point('[role=dialog] button'))
      await pause(400)
      assert.equal((await state()).expanded, 'true', 'Moving into the panel must keep it open')
      await mouse('mouseMoved', { x: 4, y: 4 })
      await pause(400)
      assert.equal((await state()).expanded, 'false', 'Leaving an unfocused panel must close')
    })
    await check(`${name}-390-touch`, async () => {
      await load(name, 390)
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
      await touch(triggerSelector(name))
      await waitFor('!!document.querySelector("[role=dialog]")')
      const bounds = await evaluate(`(() => {const r=document.querySelector('[role=dialog]').getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()`)
      assert.ok(bounds.left >= 11 && bounds.right <= 379 && bounds.top >= 11 && bounds.bottom <= 833, 'Panel must stay inside 390px viewport')
      const scroller = '[role=dialog] [tabindex="0"]'
      const position = await point(scroller)
      const before = await evaluate(`document.querySelector('${scroller}').scrollTop`)
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: position.x, y: position.y + 80 }] })
      for (let i = 1; i <= 10; i++) {
        await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: position.x, y: position.y + 80 - i * 16 }] })
        await pause(20)
      }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await pause(200)
      const after = await evaluate(`document.querySelector('${scroller}').scrollTop`)
      assert.ok(after > before, 'Trusted touch swipe must scroll the original text')
      await screenshot(`${name}-390-touch`)
      await writeFile(path.join(output, `${name}-390-touch.json`), JSON.stringify({ bounds, before, after }, null, 2))
      await touch('[role=dialog] button[aria-label="关闭"]')
      await pause(400)
      assert.equal((await state()).dialogs, 0)
      assert.ok((await state()).activeIsTrigger)
      await send('Emulation.setTouchEmulationEnabled', { enabled: false })
    })
  }
  assert.deepEqual(exceptions, [], 'No browser runtime exceptions')
  assert.deepEqual(requests.filter(url => /\/api\/|\/socket.io\//.test(url)), [], 'Component fixture must not call backend APIs')
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ fixture, input: 'Chrome CDP trusted keyboard/mouse/touch; no DOM focus/dispatchEvent or forced open', results, exceptions, apiRequests: requests.filter(url => /\/api\/|\/socket.io\//.test(url)) }, null, 2))
  socket.close()
  await fetch(`${debugging}/json/close/${target.id}`)
}
console.log(JSON.stringify(results.map(({ name, passed, error }) => ({ name, passed, error })), null, 2))
if (results.some(result => !result.passed)) process.exitCode = 1
