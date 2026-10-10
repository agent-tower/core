import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const fixturePath = '/src/pages/__tests__/provider-settings-layout.fixture.html'
const totalTimeoutMs = 45_000
const stepTimeoutMs = 8_000

class InfrastructureBlocker extends Error {}

let viteProcess
let chromeProcess
let cdp
let chromeProfileDir

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function withTimeout(promise, timeoutMs, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function terminate(child, signal) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    // The process may already be gone.
  }
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  terminate(child, 'SIGTERM')
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(1_000),
  ])
  if (child.exitCode === null) terminate(child, 'SIGKILL')
}

async function cleanup() {
  cdp?.close()
  await Promise.all([stopProcess(chromeProcess), stopProcess(viteProcess)])
  if (chromeProfileDir) await rm(chromeProfileDir, { recursive: true, force: true })
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function isExecutable(candidate) {
  if (!candidate) return false
  try {
    const info = await stat(candidate)
    return info.isFile()
  } catch {
    return false
  }
}

async function resolveChrome() {
  const explicitCandidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  for (const candidate of explicitCandidates) {
    if (await isExecutable(candidate)) return candidate
  }

  for (const command of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      encoding: 'utf8',
    })
    const candidate = lookup.status === 0 ? lookup.stdout.trim().split(/\r?\n/)[0] : ''
    if (await isExecutable(candidate)) return candidate
  }
  throw new InfrastructureBlocker(
    'No Chrome/Chromium runtime found. Set CHROME_PATH to a runnable browser binary.',
  )
}

function captureOutput(child) {
  let output = ''
  const append = chunk => {
    output = `${output}${String(chunk)}`.slice(-12_000)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  return () => output
}

async function waitForHttp(url, process, readOutput, label) {
  const deadline = Date.now() + stepTimeoutMs
  let lastError = 'not ready'
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new InfrastructureBlocker(
        `${label} exited before becoming ready (exitCode=${process.exitCode}): ${readOutput()}`,
      )
    }
    try {
      const response = await fetch(url)
      if (response.ok) return response
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(100)
  }
  throw new InfrastructureBlocker(`${label} readiness timeout: ${lastError}`)
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocket = new WebSocket(webSocketUrl)
    this.nextId = 1
    this.pending = new Map()
    this.runtimeExceptions = []
  }

  async open() {
    await withTimeout(new Promise((resolve, reject) => {
      this.webSocket.addEventListener('open', resolve, { once: true })
      this.webSocket.addEventListener('error', () => reject(new Error('CDP WebSocket failed')), { once: true })
    }), stepTimeoutMs, 'CDP WebSocket open timeout')

    this.webSocket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
        return
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const description = message.params?.exceptionDetails?.exception?.description
          ?? message.params?.exceptionDetails?.text
          ?? 'Unknown runtime exception'
        this.runtimeExceptions.push(description)
      }
    })
    this.webSocket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('CDP WebSocket closed'))
      }
      this.pending.clear()
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command timeout: ${method}`))
      }, stepTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.webSocket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try {
      this.webSocket.close()
    } catch {
      // Cleanup is best effort.
    }
  }
}

async function evaluate(expression, scenario, locator) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    const measurements = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? 'unknown evaluation failure'
    fail(scenario, 'runtime-evaluation', locator, measurements)
  }
  return result.result?.value
}

async function waitFor(expression, scenario, locator) {
  const deadline = Date.now() + stepTimeoutMs
  let lastValue
  while (Date.now() < deadline) {
    lastValue = await evaluate(expression, scenario, locator)
    if (lastValue) return lastValue
    await delay(50)
  }
  fail(scenario, 'locator-timeout', locator, {
    lastValue,
    runtimeExceptions: cdp.runtimeExceptions.slice(-3),
  })
}

function fail(scenario, assertion, locator, measurements) {
  const details = typeof measurements === 'string'
    ? measurements
    : JSON.stringify(measurements)
  throw new Error(
    `[provider-settings-layout] scenario=${scenario} assertion=${assertion} locator=${locator} measurements=${details}`,
  )
}

function assertLayout(condition, scenario, assertion, locator, measurements) {
  if (!condition) fail(scenario, assertion, locator, measurements)
}

function assertNoDocumentOverflow(measurements, scenario) {
  assertLayout(
    measurements.documentElement.scrollWidth <= measurements.documentElement.clientWidth,
    scenario,
    'documentElement-scrollWidth',
    'document.documentElement',
    measurements.documentElement,
  )
  assertLayout(
    measurements.body.scrollWidth <= measurements.viewport.width,
    scenario,
    'body-scrollWidth',
    'document.body',
    { ...measurements.body, viewportWidth: measurements.viewport.width },
  )
}

function assertRectWithin(rect, boundary, scenario, locator) {
  assertLayout(
    rect.width > 0
      && rect.left >= boundary.left - 0.5
      && rect.right <= boundary.right + 0.5,
    scenario,
    'horizontal-bounds',
    locator,
    { rect, boundary },
  )
}

function assertNoOverlap(first, second, scenario, locator) {
  const overlaps = first.left < second.right - 0.5
    && first.right > second.left + 0.5
    && first.top < second.bottom - 0.5
    && first.bottom > second.top + 0.5
  assertLayout(!overlaps, scenario, 'unexpected-overlap', locator, { first, second })
}

const measureDocumentExpression = `(() => ({
  viewport: { width: window.innerWidth, height: window.innerHeight },
  documentElement: {
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  },
  body: {
    scrollWidth: document.body.scrollWidth,
    clientWidth: document.body.clientWidth,
  },
}))()`

const rectFunction = `element => {
  const rect = element.getBoundingClientRect()
  return {
    left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
    width: rect.width, height: rect.height,
  }
}`

async function navigateFixture(url, viewport) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.width < 600,
  })
  await cdp.send('Page.navigate', { url })
  await waitFor(
    `window.__PROVIDER_LAYOUT_FIXTURE_READY__ === true
      && document.querySelector('button[aria-current="true"]') !== null`,
    `${viewport.width}x${viewport.height}:load`,
    'button[aria-current="true"]',
  )
}

async function testViewport(url, viewport) {
  await navigateFixture(url, viewport)
  const viewportBoundary = { left: 0, right: viewport.width }
  const listScenario = `${viewport.width}x${viewport.height}:provider-list`
  const listMeasurements = await evaluate(`(() => {
    const rect = ${rectFunction}
    const selected = document.querySelector('button[aria-current="true"]')
    const list = selected.parentElement
    const heading = [...document.querySelectorAll('h3')]
      .find(item => item.textContent.includes('Codex Provider'))
    return {
      document: ${measureDocumentExpression},
      selected: rect(selected),
      list: rect(list),
      listDisplay: getComputedStyle(list).display,
      detailDisplay: heading ? getComputedStyle(heading.closest('.rounded-xl')).display : null,
    }
  })()`, listScenario, 'button[aria-current="true"]')
  assertNoDocumentOverflow(listMeasurements.document, listScenario)
  assertRectWithin(listMeasurements.selected, viewportBoundary, listScenario, 'button[aria-current="true"]')
  assertRectWithin(listMeasurements.list, viewportBoundary, listScenario, 'selected-provider-list')
  assertLayout(listMeasurements.listDisplay !== 'none', listScenario, 'provider-list-visible', 'selected-provider-list', listMeasurements)
  const blockedListItem = await evaluate(`(() => {
    const list = document.querySelector('button[aria-current="true"]')?.parentElement
    const item = [...list.querySelectorAll('button')]
      .find(button => button.textContent.includes('Blocked Codex'))
    const dot = item?.querySelector('span[title]')
    return { text: item?.textContent, status: dot?.getAttribute('title') }
  })()`, listScenario, 'blocked-provider-list-item')
  assertLayout(
    blockedListItem?.status?.includes('不可用') && blockedListItem?.text?.includes('sandbox_workspace_write'),
    listScenario,
    'blocked-provider-reason-visible',
    'blocked-provider-list-item',
    blockedListItem,
  )
  if (viewport.width < 1024) {
    assertLayout(listMeasurements.detailDisplay === 'none', listScenario, 'mobile-detail-hidden', 'provider-detail', listMeasurements)
  }

  await evaluate(`document.querySelector('button[aria-current="true"]').click()`, listScenario, 'button[aria-current="true"]')
  await waitFor(
    `[...document.querySelectorAll('button')].some(button => button.textContent.trim() === '编辑'
      && getComputedStyle(button).display !== 'none')`,
    `${viewport.width}x${viewport.height}:provider-detail`,
    'button[text="编辑"]',
  )

  const detailScenario = `${viewport.width}x${viewport.height}:provider-detail`
  const detailMeasurements = await evaluate(`(() => {
    const rect = ${rectFunction}
    const selected = document.querySelector('button[aria-current="true"]')
    const list = selected.parentElement
    const edit = [...document.querySelectorAll('button')]
      .find(button => button.textContent.trim() === '编辑' && getComputedStyle(button).display !== 'none')
    const detail = edit.closest('.rounded-xl')
    const title = detail.querySelector('h3')
    const actions = edit.parentElement
    return {
      document: ${measureDocumentExpression},
      list: rect(list),
      listDisplay: getComputedStyle(list).display,
      detail: rect(detail),
      detailDisplay: getComputedStyle(detail).display,
      title: rect(title),
      actions: rect(actions),
    }
  })()`, detailScenario, 'provider-detail')
  assertNoDocumentOverflow(detailMeasurements.document, detailScenario)
  assertRectWithin(detailMeasurements.detail, viewportBoundary, detailScenario, 'provider-detail')
  assertRectWithin(detailMeasurements.title, viewportBoundary, detailScenario, 'provider-detail h3')
  assertRectWithin(detailMeasurements.actions, viewportBoundary, detailScenario, 'provider-detail actions')
  assertNoOverlap(detailMeasurements.title, detailMeasurements.actions, detailScenario, 'provider-detail title/actions')
  assertLayout(detailMeasurements.detailDisplay !== 'none', detailScenario, 'provider-detail-visible', 'provider-detail', detailMeasurements)
  if (viewport.width < 1024) {
    assertLayout(detailMeasurements.listDisplay === 'none', detailScenario, 'mobile-list-hidden', 'selected-provider-list', detailMeasurements)
  } else {
    assertLayout(
      detailMeasurements.list.right <= detailMeasurements.detail.left + 0.5,
      detailScenario,
      'desktop-master-detail-separation',
      'provider-list/provider-detail',
      detailMeasurements,
    )
  }

  await evaluate(`([...document.querySelectorAll('button')]
    .find(button => button.textContent.trim() === '编辑' && getComputedStyle(button).display !== 'none')).click()`, detailScenario, 'button[text="编辑"]')
  await waitFor(
    `[...document.querySelectorAll('h3')].some(heading => heading.textContent.trim() === '编辑 Provider')`,
    `${viewport.width}x${viewport.height}:modal-collapsed`,
    'h3[text="编辑 Provider"]',
  )

  const collapsedScenario = `${viewport.width}x${viewport.height}:modal-collapsed`
  const collapsedMeasurements = await evaluate(`(() => {
    const rect = ${rectFunction}
    const title = [...document.querySelectorAll('h3')]
      .find(heading => heading.textContent.trim() === '编辑 Provider')
    const content = title.parentElement.parentElement
    const header = content.children[0]
    const body = content.children[1]
    const footer = content.children[2]
    const fields = [
      document.querySelector('#provider-name'),
      document.querySelector('#provider-api-url'),
      document.querySelector('#provider-model'),
      document.querySelector('[role="slider"]'),
    ].map(rect)
    const advanced = [...document.querySelectorAll('button')]
      .find(button => button.textContent.trim() === '高级配置')
    return {
      document: ${measureDocumentExpression},
      content: rect(content), header: rect(header), body: rect(body), footer: rect(footer),
      fields,
      advanced: rect(advanced),
      advancedExpanded: advanced.getAttribute('aria-expanded'),
    }
  })()`, collapsedScenario, 'h3[text="编辑 Provider"]')
  assertNoDocumentOverflow(collapsedMeasurements.document, collapsedScenario)
  assertRectWithin(collapsedMeasurements.content, viewportBoundary, collapsedScenario, 'modal-content')
  assertRectWithin(collapsedMeasurements.header, collapsedMeasurements.content, collapsedScenario, 'modal-header')
  assertRectWithin(collapsedMeasurements.body, collapsedMeasurements.content, collapsedScenario, 'modal-body')
  assertRectWithin(collapsedMeasurements.footer, collapsedMeasurements.content, collapsedScenario, 'modal-footer')
  assertRectWithin(collapsedMeasurements.advanced, collapsedMeasurements.body, collapsedScenario, 'button[text="高级配置"]')
  for (const [index, rect] of collapsedMeasurements.fields.entries()) {
    assertRectWithin(rect, collapsedMeasurements.body, collapsedScenario, `modal-key-field[${index}]`)
  }
  for (let index = 1; index < collapsedMeasurements.fields.length; index += 1) {
    assertNoOverlap(
      collapsedMeasurements.fields[index - 1],
      collapsedMeasurements.fields[index],
      collapsedScenario,
      `modal-key-field[${index - 1}]/modal-key-field[${index}]`,
    )
  }
  assertNoOverlap(collapsedMeasurements.header, collapsedMeasurements.body, collapsedScenario, 'modal-header/modal-body')
  assertNoOverlap(collapsedMeasurements.body, collapsedMeasurements.footer, collapsedScenario, 'modal-body/modal-footer')
  assertLayout(
    collapsedMeasurements.advancedExpanded === 'false',
    collapsedScenario,
    'advanced-collapsed',
    'button[text="高级配置"]',
    collapsedMeasurements.advancedExpanded,
  )

  await evaluate(`([...document.querySelectorAll('button')]
    .find(button => button.textContent.trim() === '高级配置')).click()`, collapsedScenario, 'button[text="高级配置"]')
  await waitFor(
    `document.querySelectorAll('textarea').length === 2
      && [...document.querySelectorAll('button')]
        .some(button => button.textContent.trim() === '高级配置'
          && button.getAttribute('aria-expanded') === 'true')`,
    `${viewport.width}x${viewport.height}:modal-expanded`,
    'button[text="高级配置"][aria-expanded="true"]',
  )

  const expandedScenario = `${viewport.width}x${viewport.height}:modal-expanded`
  const expandedMeasurements = await evaluate(`(() => {
    const rect = ${rectFunction}
    const title = [...document.querySelectorAll('h3')]
      .find(heading => heading.textContent.trim() === '编辑 Provider')
    const content = title.parentElement.parentElement
    const body = content.children[1]
    const advanced = [...document.querySelectorAll('button')]
      .find(button => button.textContent.trim() === '高级配置')
    return {
      document: ${measureDocumentExpression},
      content: rect(content),
      body: rect(body),
      advanced: rect(advanced),
      textareas: [...document.querySelectorAll('textarea')].map(rect),
      bodyScroll: { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth },
    }
  })()`, expandedScenario, 'button[text="高级配置"][aria-expanded="true"]')
  assertNoDocumentOverflow(expandedMeasurements.document, expandedScenario)
  assertLayout(
    expandedMeasurements.bodyScroll.scrollWidth <= expandedMeasurements.bodyScroll.clientWidth,
    expandedScenario,
    'modal-body-scrollWidth',
    'modal-body',
    expandedMeasurements.bodyScroll,
  )
  assertRectWithin(expandedMeasurements.content, viewportBoundary, expandedScenario, 'modal-content')
  assertRectWithin(expandedMeasurements.advanced, expandedMeasurements.body, expandedScenario, 'button[text="高级配置"]')
  for (const [index, rect] of expandedMeasurements.textareas.entries()) {
    assertRectWithin(rect, expandedMeasurements.body, expandedScenario, `textarea[${index}]`)
  }
  assertNoOverlap(
    expandedMeasurements.textareas[0],
    expandedMeasurements.textareas[1],
    expandedScenario,
    'textarea[0]/textarea[1]',
  )

  console.log(
    `[provider-settings-layout] viewport=${viewport.width}x${viewport.height} status=passed `
      + `collapsedScrollWidth=${collapsedMeasurements.document.documentElement.scrollWidth} `
      + `expandedScrollWidth=${expandedMeasurements.document.documentElement.scrollWidth}`,
  )
}

async function testStartViewport(url, viewport) {
  const scenario = `${viewport.width}x${viewport.height}:start-provider`
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.width < 600,
  })
  await cdp.send('Page.navigate', { url: `${url}?start` })
  await waitFor(
    `window.__PROVIDER_LAYOUT_FIXTURE_READY__ === true
      && [...document.querySelectorAll('main button')].some(button => button.textContent.includes('Codex Provider With'))`,
    scenario,
    'ready-provider-trigger',
  )
  await evaluate(`([...document.querySelectorAll('main button')]
    .find(button => button.textContent.includes('Codex Provider With'))).click()`, scenario, 'ready-provider-trigger')
  await waitFor(
    `[...document.querySelectorAll('main button')].some(button => button.textContent.includes('Blocked Codex'))`,
    scenario,
    'blocked-provider-option',
  )
  const initial = await evaluate(`(() => {
    const rect = ${rectFunction}
    const blocked = [...document.querySelectorAll('main button')]
      .find(button => button.textContent.includes('Blocked Codex'))
    const menu = blocked.parentElement.parentElement
    const group = blocked.parentElement
    group.focus()
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return {
      document: ${measureDocumentExpression},
      menu: rect(menu),
      option: rect(blocked),
      disabled: blocked.disabled,
      text: blocked.textContent,
      focusableReason: group.tabIndex === 0 && document.activeElement === group,
      selected: [...document.querySelectorAll('main button')]
        .find(button => button.textContent.includes('Codex Provider With'))?.textContent,
    }
  })()`, scenario, 'blocked-provider-option')
  assertNoDocumentOverflow(initial.document, scenario)
  assertRectWithin(initial.menu, { left: 0, right: viewport.width }, scenario, 'provider-menu')
  assertRectWithin(initial.option, initial.menu, scenario, 'blocked-provider-option')
  assertLayout(initial.disabled && initial.focusableReason
    && initial.text.includes('自动同意（沙箱）')
    && initial.text.includes('sandbox_workspace_write')
    && initial.selected.includes('Codex Provider With'),
  scenario, 'blocked-option-keyboard-and-reason', 'blocked-provider-option', initial)

  await evaluate(`window.__SET_START_PROVIDER_CAPABILITY__(true)`, scenario, 'capability-refresh')
  await waitFor(
    `[...document.querySelectorAll('main [role="alert"]')].some(item => item.textContent.includes('Native approval unavailable after refresh'))`,
    scenario,
    'selected-provider-blocked-after-refresh',
  )
  const refreshed = await evaluate(`(() => ({
    document: ${measureDocumentExpression},
    selected: [...document.querySelectorAll('main button')]
      .find(button => button.textContent.includes('Codex Provider With'))?.textContent,
    submitDisabled: [...document.querySelectorAll('main button')]
      .find(button => button.querySelector('svg.lucide-arrow-up'))?.disabled,
  }))()`, scenario, 'capability-refresh')
  assertNoDocumentOverflow(refreshed.document, scenario)
  assertLayout(refreshed.selected?.includes('Codex Provider With') && refreshed.submitDisabled,
    scenario, 'refresh-preserves-blocked-choice', 'start-input', refreshed)
  console.log(`[provider-settings-layout] viewport=${viewport.width}x${viewport.height} startProvider=passed`)
}

async function runHarness() {
  const vitePort = await freePort()
  const chromePort = await freePort()
  const chromePath = await resolveChrome()
  const fixtureUrl = `http://127.0.0.1:${vitePort}${fixturePath}`

  viteProcess = spawn(pnpmCommand, [
    '--filter', 'web', 'exec', 'vite',
    '--host', '127.0.0.1',
    '--port', String(vitePort),
    '--strictPort',
  ], {
    cwd: repoRoot,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const readViteOutput = captureOutput(viteProcess)
  await waitForHttp(fixtureUrl, viteProcess, readViteOutput, 'Vite fixture server')
  console.log(`[provider-settings-layout] fixtureUrl=${fixtureUrl}`)

  chromeProfileDir = await mkdtemp(path.join(tmpdir(), 'agent-tower-provider-settings-'))
  const chromeArgs = [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${chromeProfileDir}`,
    'about:blank',
  ]
  if (typeof process.getuid === 'function' && process.getuid() === 0) chromeArgs.unshift('--no-sandbox')
  chromeProcess = spawn(chromePath, chromeArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const readChromeOutput = captureOutput(chromeProcess)
  const targetsResponse = await waitForHttp(
    `http://127.0.0.1:${chromePort}/json/list`,
    chromeProcess,
    readChromeOutput,
    'Headless Chrome',
  )
  const targets = await targetsResponse.json()
  const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl)
  if (!page) throw new InfrastructureBlocker('Headless Chrome exposed no debuggable page target')

  cdp = new CdpClient(page.webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await testViewport(fixtureUrl, viewport)
    await testStartViewport(fixtureUrl, viewport)
  }
}

try {
  await withTimeout(
    runHarness(),
    totalTimeoutMs,
    `[provider-settings-layout] scenario=harness assertion=total-timeout locator=all measurements={"timeoutMs":${totalTimeoutMs}}`,
  )
} catch (error) {
  if (error instanceof InfrastructureBlocker) {
    console.error(`[provider-settings-layout] infrastructure_blocker=${error.message}`)
    process.exitCode = 2
  } else {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
} finally {
  await cleanup()
}
