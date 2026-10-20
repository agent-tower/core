import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { Server } from '@probe/socket-io'
import { io as connectSocket } from '@probe/socket-io-client'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
const fixture = vi.hoisted(() => ({ service: null as any, bus: null as any }))
vi.mock('@probe/server/core/container.js', () => ({
  getTranslationService: () => fixture.service,
  getEventBus: () => fixture.bus,
}))
const executionRoot = path.resolve(process.env.ROOM_SOCKET_EXECUTION_ROOT ?? path.join(import.meta.dirname, '../../..'))
const serverRoot = path.join(executionRoot, 'packages/server')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-room-socket-expiry-'))
process.env.AGENT_TOWER_DATABASE_URL = `file:${path.join(dataDir,'test.db')}`
process.env.AGENT_TOWER_DATA_DIR = dataDir
let db: any, auth: any, Gateway: any, authMiddleware: any, TranslationService: any, Settings: any, EventBus: any
let record: any, room: any, message: any, source: any, event: any, nsp: any, io: any, gateway: any, port: number
const clients: any[] = []
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
let settingsReadGate: { gate: ReturnType<typeof defer>; entered: ReturnType<typeof defer>; reads: number } | null = null
const received = new Map<any, any[]>()
const wire = { subscribe:'subscribe', unsubscribe:'unsubscribe', invalidated:'translation:invalidated' }
const draft = { enabled:true, apiBaseUrl:'https://translator.test/v1', model:'fixture', apiKey:{action:'replace',value:''}, sendTargetLanguage:'English', displayTargetLanguage:'Chinese', promptTemplate:'{{target_language}}\n{{text}}', maxConcurrency:2 }

beforeAll(async () => {
  execFileSync('pnpm',['exec','prisma','db','push','--skip-generate',`--schema=${path.join(serverRoot,'prisma/schema.prisma')}`],{cwd:serverRoot,env:{...process.env},stdio:'pipe'})
  db = (await import('@probe/server/utils/index.js')).prisma
  db.$use(async (params: any, next: (params: any) => Promise<any>) => {
    const held = params.model === 'AccessAuthSettings' && params.action === 'findUnique' ? settingsReadGate : null
    const row = await next(params)
    if (held) { ++held.reads; held.entered.resolve(); await held.gate.promise }
    return row
  })
  auth = (await import('@probe/server/services/access-auth.service.js')).AccessAuthService
  Gateway = (await import('@probe/server/socket/socket-gateway.js')).SocketGateway
  authMiddleware = (await import('@probe/server/socket/middleware/auth.js')).authMiddleware
  TranslationService = (await import('@probe/server/services/translation.service.js')).TranslationService
  Settings = (await import('@probe/server/services/translation-settings.service.js')).TranslationSettingsService
  EventBus = (await import('@probe/server/core/event-bus.js')).EventBus
})
beforeEach(async () => {
  await db.translationSource.deleteMany(); await db.session.deleteMany(); await db.conversation.deleteMany(); await db.project.deleteMany(); await db.translationSettings.deleteMany(); await db.accessAuthSettings.deleteMany()
  auth.__test.resetSettingsCache(); auth.__test.resetSessionSecretGeneration()
  record = await db.accessAuthSettings.create({data:{enabled:true,sessionSecret:randomUUID()}})
  const settings = new Settings(db); await settings.save({...draft,expectedRevision:0})
  fixture.service = new TranslationService(db, settings)
  fixture.bus = new EventBus()
  const project = await db.project.create({data:{name:'Review fixture',repoPath:dataDir}})
  const task = await db.task.create({data:{title:'Review fixture',projectId:project.id}})
  room = await db.teamRun.create({data:{taskId:task.id,mode:'AUTO'}})
  message = await db.roomMessage.create({data:{teamRunId:room.id,senderType:'agent',kind:'artifact',content:'Original fixture text',mentions:'[]',translationEligibilityEpoch:(await settings.getPublic()).enableEpoch}})
  source = await fixture.service.registerSource({kind:'ROOM_MESSAGE',messageId:message.id})
  event = {teamRunId:room.id,messageId:message.id,sourceId:source.id,sourceRevision:source.sourceRevision,overlayRevision:source.overlayRevision}
  const http = createServer()
  io = new Server(http)
  nsp = io.of('/events'); nsp.use(authMiddleware)
  gateway = new Gateway(nsp,fixture.bus,{}, {cleanupBySocket:async () => {}})
  nsp.on('connection',(socket: any) => gateway.register(socket))
  await new Promise<void>(resolve => http.listen(0,'127.0.0.1',resolve))
  port = (http.address() as any).port
})
afterEach(async () => {
  settingsReadGate = null
  for (const client of clients.splice(0)) client.disconnect()
  received.clear(); gateway?.destroy(); if (io) await new Promise<void>(r => io.close(() => r()))
  await fixture.service?.shutdown(); vi.restoreAllMocks(); delete process.env.AGENT_TOWER_INTERNAL_TOKEN
})
afterAll(async () => { await db?.$disconnect(); fs.rmSync(dataDir,{recursive:true,force:true}) })
function makeToken(ttl = 60000) {
  const clock = vi.spyOn(Date,'now').mockReturnValue(Date.now()-7*24*60*60*1000+ttl)
  const token = auth.__test.createSessionToken(record); clock.mockRestore()
  return { token, expires: Number(token.split('.')[1]) }
}
async function connect(token?: string, headers: Record<string,string> = {}) {
  const client = connectSocket(`http://127.0.0.1:${port}/events`,{transports:['websocket'],reconnection:false,extraHeaders:{...(token?{cookie:`agent-tower-access=${token}`} : {}),...headers}})
  clients.push(client); received.set(client,[])
  client.on(wire.invalidated,(p:any) => received.get(client)?.push(p))
  await new Promise<void>((resolve,reject) => { client.once('connect',resolve); client.once('connect_error',reject) })
  ;(client as any).__fixtureSocketId = client.id
  return client
}
const subscribe = (client:any,id:any=room.id) => new Promise<any>((resolve,reject) => client.timeout(2000).emit(wire.subscribe,{topic:'team-run',id},(err:any,ack:any)=>err?reject(err):resolve(ack)))
const unsubscribe = (client:any) => new Promise<any>((resolve,reject) => client.timeout(2000).emit(wire.unsubscribe,{topic:'team-run',id:room.id},(err:any,ack:any)=>err?reject(err):resolve(ack)))

function holdPreparedValidation(targetCall: number) {
  const gate = defer(), entered = defer()
  const real = auth.prepareSessionTokenValidation.bind(auth)
  let calls = 0, check: (() => boolean) | undefined
  vi.spyOn(auth, 'prepareSessionTokenValidation').mockImplementation(async (token: string | null) => {
    const call = ++calls
    const predicate = await real(token)
    if (call === targetCall) {
      check = predicate
      expect(predicate()).toBe(true)
      entered.resolve()
      await gate.promise
    }
    return predicate
  })
  return { gate, entered, check: () => { expect(check).toBeTypeOf('function'); return check!() } }
}

function holdValidationSettingsRead(targetCall: number) {
  const gate = defer(), entered = defer()
  const prepare = auth.prepareSessionTokenValidation.bind(auth)
  const state = { gate, entered, reads: 0 }
  let calls = 0
  vi.spyOn(auth, 'prepareSessionTokenValidation').mockImplementation(async (token: string | null) => {
    if (++calls === targetCall) {
      settingsReadGate = state
      auth.__test.resetSettingsCache()
    }
    return prepare(token)
  })
  return { gate, entered, reads: () => state.reads }
}

function holdRoomLookup(targetCall = 2) {
  const gate = defer(), entered = defer()
  const real = fixture.service.assertReadableTeamRun.bind(fixture.service)
  let calls = 0
  vi.spyOn(fixture.service, 'assertReadableTeamRun').mockImplementation(async (...args: any[]) => {
    await real(...args)
    if (++calls === targetCall) { entered.resolve(); await gate.promise }
  })
  return { gate, entered }
}

async function expireNaturally(expires: number) {
  await pause(Math.max(0, expires - Date.now() + 25))
  expect(Date.now()).toBeGreaterThan(expires)
}

const joined = (client: any, topic = 'team-run', id = room.id) => nsp.adapter.rooms.get(`${topic}:${id}`)?.has(client.__fixtureSocketId ?? client.id) ?? false

async function createChatSession(purpose = 'CHAT') {
  const conversation = await db.conversation.create({ data: { title: 'Socket fixture', directoryName: randomUUID(), workingDir: dataDir } })
  return db.session.create({ data: { conversationId: conversation.id, context: 'CONVERSATION', agentType: 'CODEX', prompt: 'Synthetic fixture', purpose } })
}

const sessionSubscribe = (client: any, id: string) => new Promise<any>((resolve, reject) => client.timeout(2000).emit(wire.subscribe, { topic: 'session', id }, (err: any, ack: any) => err ? reject(err) : resolve(ack)))
const sessionUnsubscribe = (client: any, id: string) => new Promise<any>((resolve, reject) => client.timeout(2000).emit(wire.unsubscribe, { topic: 'session', id }, (err: any, ack: any) => err ? reject(err) : resolve(ack)))

it('real Socket.IO auth + Gateway deliver ID-only events to subscribed owners and reject all/Agent/internal',async () => {
  await expect(connect()).rejects.toThrow('access password')
  const {token} = makeToken()
  const owner = await connect(token)
  expect(await subscribe(owner)).toEqual({success:true})
  expect(await subscribe(owner,'all')).toMatchObject({success:false})
  const agent = await connect(token,{'x-agent-tower-agent-credential':'fixture-agent'})
  expect(await subscribe(agent)).toMatchObject({success:false})
  const internalToken = randomUUID(); process.env.AGENT_TOWER_INTERNAL_TOKEN = internalToken
  const internal = await connect(undefined, {'x-agent-tower-internal-token':internalToken})
  expect(await subscribe(internal)).toMatchObject({success:false})
  fixture.bus.emit(wire.invalidated,{...event,unexpectedBody:'must be stripped'})
  await pause(100)
  expect(received.get(owner)).toEqual([event]); expect(received.get(agent)).toEqual([]); expect(received.get(internal)).toEqual([])
  await unsubscribe(owner); fixture.bus.emit(wire.invalidated,event); await pause(60)
  expect(received.get(owner)).toEqual([event])
})

it('must reject a forward whose cookie expires during source lookup',async () => {
  const {token,expires} = makeToken(1000)
  const owner = await connect(token); expect(await subscribe(owner)).toEqual({success:true})
  const generation = auth.getSessionSecretGeneration()
  const gate=defer(), entered=defer()
  const real = fixture.service.assertReadableRoomTranslation.bind(fixture.service)
  vi.spyOn(fixture.service,'assertReadableRoomTranslation').mockImplementation(async (...args:any[]) => {
    await real(...args); entered.resolve(); await gate.promise
  })
  try {
    fixture.bus.emit(wire.invalidated,event); await entered.promise
    expect(await auth.validateSessionToken(token)).toBe(true)
    await pause(Math.max(0,expires-Date.now()+25))
    expect(await auth.validateSessionToken(token)).toBe(false)
    expect(auth.getSessionSecretGeneration()).toBe(generation)
    gate.resolve(); await pause(70)
    console.log(JSON.stringify({case:'expiry-during-forward',authValid:false,generationUnchanged:true,notifications:received.get(owner)?.length}))
    expect(received.get(owner)).toEqual([])
  } finally { gate.resolve() }
})

it('must reject a subscription whose cookie expires during the final room lookup',async () => {
  const {token,expires} = makeToken(1000)
  const owner = await connect(token)
  const gate=defer(), entered=defer()
  const real=fixture.service.assertReadableTeamRun.bind(fixture.service); let calls=0
  vi.spyOn(fixture.service,'assertReadableTeamRun').mockImplementation(async (...args:any[]) => {
    await real(...args); if (++calls===2) { entered.resolve(); await gate.promise }
  })
  try {
    const pending=subscribe(owner); await entered.promise
    expect(await auth.validateSessionToken(token)).toBe(true)
    await pause(Math.max(0,expires-Date.now()+25))
    expect(await auth.validateSessionToken(token)).toBe(false)
    gate.resolve(); const ack=await pending
    console.log(JSON.stringify({case:'expiry-during-subscribe',authValid:false,ack,joined:nsp.adapter.rooms.get(`team-run:${room.id}`)?.has(owner.id)}))
    expect(ack).toMatchObject({success:false})
    expect(nsp.adapter.rooms.get(`team-run:${room.id}`)?.has(owner.id) ?? false).toBe(false)
  } finally { gate.resolve() }
})

it('pending unsubscribe during source lookup suppresses a delayed event',async () => {
  const {token}=makeToken(); const owner=await connect(token); expect(await subscribe(owner)).toEqual({success:true})
  const gate=defer(), entered=defer(), real=fixture.service.assertReadableRoomTranslation.bind(fixture.service)
  vi.spyOn(fixture.service,'assertReadableRoomTranslation').mockImplementation(async (...args:any[]) => { await real(...args); entered.resolve(); await gate.promise })
  try { fixture.bus.emit(wire.invalidated,event); await entered.promise; await unsubscribe(owner); gate.resolve(); await pause(70); expect(received.get(owner)).toEqual([]) }
  finally { gate.resolve() }
})


it('rejects naturally expired cookies before subscribe/forward begins',async () => {
  const {token,expires}=makeToken(500); const owner=await connect(token); expect(await subscribe(owner)).toEqual({success:true})
  await pause(Math.max(0,expires-Date.now()+25)); expect(await auth.validateSessionToken(token)).toBe(false)
  fixture.bus.emit(wire.invalidated,event); await pause(70); expect(received.get(owner)).toEqual([])
  expect(await subscribe(owner)).toMatchObject({success:false})
})

it('secret generation rotation during source lookup suppresses a delayed event',async () => {
  const {token}=makeToken(); const owner=await connect(token); expect(await subscribe(owner)).toEqual({success:true})
  const gate=defer(), entered=defer(), real=fixture.service.assertReadableRoomTranslation.bind(fixture.service)
  vi.spyOn(fixture.service,'assertReadableRoomTranslation').mockImplementation(async (...args:any[]) => { await real(...args); entered.resolve(); await gate.promise })
  try { fixture.bus.emit(wire.invalidated,event); await entered.promise; auth.__test.notifySessionSecretRotated(); gate.resolve(); await pause(70); expect(received.get(owner)).toEqual([]) }
  finally { gate.resolve() }
})

it('rechecks real Cookie expiry after the prepared forwarding validator waits to return', async () => {
  const { token, expires } = makeToken(1000)
  const owner = await connect(token); expect(await subscribe(owner)).toEqual({ success: true })
  const generation = auth.getSessionSecretGeneration(), held = holdPreparedValidation(1)
  try {
    fixture.bus.emit(wire.invalidated, event); await held.entered.promise
    await expireNaturally(expires)
    expect(held.check()).toBe(false)
    expect(auth.getSessionSecretGeneration()).toBe(generation)
    held.gate.resolve(); await pause(70)
    expect(received.get(owner)).toEqual([])
  } finally { held.gate.resolve() }
})

it('rechecks real Cookie expiry after the final subscription validator waits to return', async () => {
  const { token, expires } = makeToken(1000)
  const owner = await connect(token), held = holdPreparedValidation(2)
  const generation = auth.getSessionSecretGeneration()
  try {
    const pending = subscribe(owner); await held.entered.promise
    expect(joined(owner)).toBe(true)
    await expireNaturally(expires)
    expect(held.check()).toBe(false)
    expect(auth.getSessionSecretGeneration()).toBe(generation)
    held.gate.resolve()
    expect(await pending).toMatchObject({ success: false })
    expect(joined(owner)).toBe(false)
  } finally { held.gate.resolve() }
})

it('rejects expiry while forwarding validation awaits an actual settings SQLite read', async () => {
  const { token, expires } = makeToken(1000)
  const owner = await connect(token); expect(await subscribe(owner)).toEqual({ success: true })
  const held = holdValidationSettingsRead(1), generation = auth.getSessionSecretGeneration()
  try {
    fixture.bus.emit(wire.invalidated, event); await held.entered.promise
    await expireNaturally(expires)
    held.gate.resolve(); await pause(70)
    expect(held.reads()).toBe(1)
    expect(auth.getSessionSecretGeneration()).toBe(generation)
    expect(await auth.validateSessionToken(token)).toBe(false)
    expect(received.get(owner)).toEqual([])
  } finally { held.gate.resolve() }
})

it('rejects expiry while final subscription validation awaits an actual settings SQLite read', async () => {
  const { token, expires } = makeToken(1000)
  const owner = await connect(token), held = holdValidationSettingsRead(2)
  const generation = auth.getSessionSecretGeneration()
  try {
    const pending = subscribe(owner); await held.entered.promise
    expect(joined(owner)).toBe(true)
    await expireNaturally(expires)
    held.gate.resolve()
    expect(await pending).toMatchObject({ success: false })
    expect(held.reads()).toBe(1)
    expect(auth.getSessionSecretGeneration()).toBe(generation)
    expect(await auth.validateSessionToken(token)).toBe(false)
    expect(joined(owner)).toBe(false)
  } finally { held.gate.resolve() }
})

it('unsubscribe during the forwarding validator return wait suppresses the event', async () => {
  const { token } = makeToken(), owner = await connect(token)
  expect(await subscribe(owner)).toEqual({ success: true })
  const held = holdPreparedValidation(1)
  try {
    fixture.bus.emit(wire.invalidated, event); await held.entered.promise
    expect(await unsubscribe(owner)).toEqual({ success: true })
    expect(held.check()).toBe(true)
    held.gate.resolve(); await pause(70)
    expect(received.get(owner)).toEqual([]); expect(joined(owner)).toBe(false)
  } finally { held.gate.resolve() }
})

it('generation rotation during the forwarding validator return wait suppresses the event', async () => {
  const { token } = makeToken(), owner = await connect(token)
  expect(await subscribe(owner)).toEqual({ success: true })
  const held = holdPreparedValidation(1), generation = auth.getSessionSecretGeneration()
  try {
    fixture.bus.emit(wire.invalidated, event); await held.entered.promise
    auth.__test.notifySessionSecretRotated()
    expect(held.check()).toBe(false)
    expect(auth.getSessionSecretGeneration()).toBe(generation + 1)
    held.gate.resolve(); await pause(70)
    expect(received.get(owner)).toEqual([]); expect(joined(owner)).toBe(false)
  } finally { held.gate.resolve() }
})

it('unsubscribe during the final subscription validator wait denies the pending subscription', async () => {
  const { token } = makeToken(), owner = await connect(token), held = holdPreparedValidation(2)
  try {
    const pending = subscribe(owner); await held.entered.promise
    expect(joined(owner)).toBe(true)
    expect(await unsubscribe(owner)).toEqual({ success: true })
    expect(held.check()).toBe(true)
    held.gate.resolve()
    expect(await pending).toMatchObject({ success: false })
    expect(joined(owner)).toBe(false)
  } finally { held.gate.resolve() }
})

it('generation rotation during final subscription validation never acknowledges success or leaves membership', async () => {
  const { token } = makeToken(), owner = await connect(token), held = holdPreparedValidation(2)
  try {
    const pending = subscribe(owner).then(ack => ({ ack }), error => ({ transportError: String(error?.message) }))
    await held.entered.promise
    expect(joined(owner)).toBe(true)
    auth.__test.notifySessionSecretRotated()
    expect(held.check()).toBe(false)
    held.gate.resolve()
    const outcome = await pending
    expect('ack' in outcome ? outcome.ack.success : false).toBe(false)
    expect(joined(owner)).toBe(false)
  } finally { held.gate.resolve() }
})

it('unsubscribe while the final real room lookup is pending denies a subscription and removes membership', async () => {
  const { token } = makeToken(), owner = await connect(token), held = holdRoomLookup()
  try {
    const pending = subscribe(owner); await held.entered.promise
    expect(joined(owner)).toBe(true)
    expect(await unsubscribe(owner)).toEqual({ success: true })
    held.gate.resolve()
    expect(await pending).toMatchObject({ success: false })
    expect(joined(owner)).toBe(false)
  } finally { held.gate.resolve() }
})

it('a newer subscription intent suppresses a stale forward while allowing a fresh notification', async () => {
  const { token } = makeToken(), owner = await connect(token)
  expect(await subscribe(owner)).toEqual({ success: true })
  const gate = defer(), entered = defer(), real = fixture.service.assertReadableRoomTranslation.bind(fixture.service)
  vi.spyOn(fixture.service, 'assertReadableRoomTranslation').mockImplementation(async (...args: any[]) => {
    await real(...args); entered.resolve(); await gate.promise
  })
  try {
    fixture.bus.emit(wire.invalidated, event); await entered.promise
    expect(await unsubscribe(owner)).toEqual({ success: true })
    expect(await subscribe(owner)).toEqual({ success: true })
    gate.resolve(); await pause(70)
    expect(joined(owner)).toBe(true); expect(received.get(owner)).toEqual([])
    fixture.bus.emit(wire.invalidated, event); await pause(70)
    expect(received.get(owner)).toEqual([event])
  } finally { gate.resolve() }
})

it('an older pending subscribe cannot remove a newer successful subscription', async () => {
  const { token } = makeToken(), owner = await connect(token), held = holdRoomLookup()
  try {
    const older = subscribe(owner); await held.entered.promise
    expect(joined(owner)).toBe(true)
    expect(await subscribe(owner)).toEqual({ success: true })
    held.gate.resolve()
    expect(await older).toMatchObject({ success: false })
    expect(joined(owner)).toBe(true)
    fixture.bus.emit(wire.invalidated, event); await pause(70)
    expect(received.get(owner)).toEqual([event])
  } finally { held.gate.resolve() }
})

it('password-disabled owners without Cookies can subscribe and receive room translations', async () => {
  await db.accessAuthSettings.update({ where: { id: record.id }, data: { enabled: false } })
  auth.__test.resetSettingsCache()
  const owner = await connect()
  expect(await subscribe(owner)).toEqual({ success: true })
  fixture.bus.emit(wire.invalidated, event); await pause(70)
  expect(received.get(owner)).toEqual([event])
  expect(await unsubscribe(owner)).toEqual({ success: true }); expect(joined(owner)).toBe(false)
})

it('TEAM_USER delivery notifications expose only IDs and revisions to subscribed owners', async () => {
  const { token } = makeToken(), owner = await connect(token)
  const agent = await connect(token, { 'x-agent-tower-agent-credential': 'fixture-agent' })
  process.env.AGENT_TOWER_INTERNAL_TOKEN = randomUUID()
  const internal = await connect(undefined, { 'x-agent-tower-internal-token': process.env.AGENT_TOWER_INTERNAL_TOKEN })
  const notifications = new Map<any, any[]>()
  for (const client of [owner, agent, internal]) { notifications.set(client, []); client.on('message-delivery:invalidated', (p: any) => notifications.get(client)!.push(p)) }
  expect(await subscribe(owner)).toEqual({ success: true })
  expect(await subscribe(agent)).toMatchObject({ success: false })
  expect(await subscribe(internal)).toMatchObject({ success: false })
  const delivery = { teamRunId: room.id, taskId: room.taskId, operationId: randomUUID(), deliveryRevision: 2 }
  fixture.bus.emit('message-delivery:invalidated', { ...delivery, originalText: 'must never reach the wire' })
  await pause(70)
  expect(notifications.get(owner)).toEqual([delivery]); expect(notifications.get(agent)).toEqual([]); expect(notifications.get(internal)).toEqual([])
  await db.task.update({ where: { id: room.taskId }, data: { deletedAt: new Date() } })
  fixture.bus.emit('message-delivery:invalidated', delivery); await pause(70)
  expect(notifications.get(owner)).toEqual([delivery])
})

it('TEAM_USER forwarding rechecks real Cookie expiry after the SQLite room lookup', async () => {
  const { token, expires } = makeToken(1000), owner = await connect(token)
  expect(await subscribe(owner)).toEqual({ success: true })
  const deliveries: any[] = []; owner.on('message-delivery:invalidated', (p: any) => deliveries.push(p))
  const held = holdRoomLookup(1), generation = auth.getSessionSecretGeneration()
  try {
    fixture.bus.emit('message-delivery:invalidated', { teamRunId: room.id, taskId: room.taskId, operationId: randomUUID(), deliveryRevision: 1 })
    await held.entered.promise; await expireNaturally(expires)
    expect(auth.getSessionSecretGeneration()).toBe(generation)
    held.gate.resolve(); await pause(70); expect(deliveries).toEqual([])
  } finally { held.gate.resolve() }
})

it('TEAM_USER unsubscribe and resubscribe suppresses an older pending forward', async () => {
  const { token } = makeToken(), owner = await connect(token)
  expect(await subscribe(owner)).toEqual({ success: true })
  const deliveries: any[] = []; owner.on('message-delivery:invalidated', (p: any) => deliveries.push(p))
  const held = holdRoomLookup(1), delivery = { teamRunId: room.id, taskId: room.taskId, operationId: randomUUID(), deliveryRevision: 1 }
  try {
    fixture.bus.emit('message-delivery:invalidated', delivery); await held.entered.promise
    expect(await unsubscribe(owner)).toEqual({ success: true }); expect(await subscribe(owner)).toEqual({ success: true })
    held.gate.resolve(); await pause(70)
    expect(joined(owner)).toBe(true); expect(deliveries).toEqual([])
    fixture.bus.emit('message-delivery:invalidated', delivery); await pause(70)
    expect(deliveries).toEqual([delivery])
  } finally { held.gate.resolve() }
})

it('preserves Session subscribe, translation/delivery forwarding, unsubscribe, and read-model rejection', async () => {
  const { token } = makeToken(), owner = await connect(token), session = await createChatSession()
  const source = await fixture.service.registerSource({ kind: 'SESSION_BLOCK', sessionId: session.id, turnId: 'turn', blockId: 'body', semanticType: 'assistant_message', text: 'Synthetic Session fixture', state: 'SEALED', sourceRevision: 1, enableEpoch: 1 })
  const translation = { sessionId: session.id, sourceId: source.id, sourceRevision: source.sourceRevision, overlayRevision: source.overlayRevision }
  const delivery = { sessionId: session.id, operationId: randomUUID(), deliveryRevision: 1 }
  const deliveries: any[] = [], subscribed: any[] = [], unsubscribed: any[] = []
  owner.on('message-delivery:invalidated', (payload: any) => deliveries.push(payload))
  owner.on('session:subscribed', (payload: any) => subscribed.push(payload))
  owner.on('session:unsubscribed', (payload: any) => unsubscribed.push(payload))
  expect(await sessionSubscribe(owner, session.id)).toEqual({ success: true })
  expect(joined(owner, 'session', session.id)).toBe(true)
  expect(subscribed).toEqual([{ sessionId: session.id }])
  fixture.bus.emit(wire.invalidated, translation); fixture.bus.emit('message-delivery:invalidated', delivery); await pause(70)
  expect(received.get(owner)).toEqual([translation]); expect(deliveries).toEqual([delivery])
  expect(await sessionUnsubscribe(owner, session.id)).toEqual({ success: true })
  expect(unsubscribed).toEqual([{ sessionId: session.id }]); expect(joined(owner, 'session', session.id)).toBe(false)
  fixture.bus.emit(wire.invalidated, translation); fixture.bus.emit('message-delivery:invalidated', delivery); await pause(70)
  expect(received.get(owner)).toEqual([translation]); expect(deliveries).toEqual([delivery])
  const commitSession = await createChatSession('COMMIT_MSG')
  expect(await sessionSubscribe(owner, commitSession.id)).toMatchObject({ success: false })
  expect(await sessionSubscribe(owner, 'all')).toMatchObject({ success: false })
  expect(await sessionSubscribe(owner, randomUUID())).toMatchObject({ success: false })
  expect(await sessionSubscribe(owner, session.id)).toEqual({ success: true })
  await db.conversation.update({ where: { id: session.conversationId }, data: { deletedAt: new Date() } })
  fixture.bus.emit(wire.invalidated, translation); fixture.bus.emit('message-delivery:invalidated', delivery); await pause(70)
  expect(received.get(owner)).toEqual([translation]); expect(deliveries).toEqual([delivery])
  expect(await sessionSubscribe(owner, session.id)).toMatchObject({ success: false })
})

it('rejects missing, mismatched, private, deleted-source, and archived room scopes using SQLite', async () => {
  const { token } = makeToken(), owner = await connect(token)
  expect(await subscribe(owner, randomUUID())).toMatchObject({ success: false })
  expect(await subscribe(owner)).toEqual({ success: true })
  fixture.bus.emit(wire.invalidated, { ...event, sourceId: randomUUID() })
  fixture.bus.emit(wire.invalidated, { ...event, messageId: randomUUID() })
  fixture.bus.emit(wire.invalidated, { ...event, sessionId: randomUUID() }); await pause(70)
  expect(received.get(owner)).toEqual([])
  await db.roomMessage.update({ where: { id: message.id }, data: { visibility: 'PRIVATE' } })
  fixture.bus.emit(wire.invalidated, event); await pause(70); expect(received.get(owner)).toEqual([])
  await db.roomMessage.update({ where: { id: message.id }, data: { visibility: 'PUBLIC' } })
  await db.translationSource.update({ where: { id: source.id }, data: { deletedAt: new Date() } })
  fixture.bus.emit(wire.invalidated, event); await pause(70); expect(received.get(owner)).toEqual([])
  await db.translationSource.update({ where: { id: source.id }, data: { deletedAt: null } })
  await db.task.update({ where: { id: room.taskId }, data: { deletedAt: new Date() } })
  expect(await subscribe(owner)).toMatchObject({ success: false })
  fixture.bus.emit(wire.invalidated, event); await pause(70); expect(received.get(owner)).toEqual([])
  await db.task.update({ where: { id: room.taskId }, data: { deletedAt: null } })
  const task = await db.task.findUniqueOrThrow({ where: { id: room.taskId } })
  await db.project.update({ where: { id: task.projectId }, data: { archivedAt: new Date() } })
  expect(await subscribe(owner)).toMatchObject({ success: false })
  fixture.bus.emit(wire.invalidated, event); await pause(70); expect(received.get(owner)).toEqual([])
  expect(joined(owner)).toBe(false)
})
