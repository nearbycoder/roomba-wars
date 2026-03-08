import { GameWorld, type PersistedStanding } from './game-world'
import {
  HEARTBEAT_MS,
  PENDING_TTL_MS,
  type ClientMessage,
  type JoinFailureResponse,
  type JoinResponse,
  type ServerMessage,
} from '../shared/protocol'

export interface Env {
  WORLD: DurableObjectNamespace
  ASSETS: Fetcher
}

const INTERNAL_HOST = 'https://world.internal'
const STANDINGS_STORAGE_KEY = 'standings'
const MAX_PENDING_PER_IP = 3
const JOIN_RATE_LIMIT = { windowMs: 60_000, limit: 12 }
const CONNECT_RATE_LIMIT = { windowMs: 60_000, limit: 24 }
const MOVE_MIN_INTERVAL_MS = 50
const ROTATE_MIN_INTERVAL_MS = 50
const PING_MIN_INTERVAL_MS = 1_000

interface PendingSessionMeta {
  ip: string
  createdAt: number
}

interface SessionThrottleState {
  ip: string
  lastMoveAt: number
  lastRotateAt: number
  lastPingAt: number
}

export class WorldDurableObject {
  private readonly world = new GameWorld()
  private readonly state: DurableObjectState
  private readonly pendingSockets = new Map<string, WebSocket>()
  private readonly activeSockets = new Map<string, WebSocket>()
  private readonly pendingSessionMeta = new Map<string, PendingSessionMeta>()
  private readonly sessionThrottleState = new Map<string, SessionThrottleState>()
  private readonly joinAttemptsByIp = new Map<string, number[]>()
  private readonly connectAttemptsByIp = new Map<string, number[]>()

  constructor(state: DurableObjectState) {
    this.state = state
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<PersistedStanding[]>(STANDINGS_STORAGE_KEY)
      this.world.restoreStandings(Array.isArray(stored) ? stored : [])
    })

    setInterval(() => {
      void this.flushWorld()
    }, HEARTBEAT_MS)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/internal/join' && request.method === 'POST') {
      return this.handleJoin(request)
    }

    if (url.pathname === '/internal/connect') {
      return this.handleSocketUpgrade(request)
    }

    return new Response('Not found', { status: 404 })
  }

  private async handleJoin(request: Request): Promise<Response> {
    this.cleanupPendingSessionMeta()
    const ip = getClientIp(request)
    if (this.isRateLimited(this.joinAttemptsByIp, ip, JOIN_RATE_LIMIT.limit, JOIN_RATE_LIMIT.windowMs)) {
      return json(
        {
          ok: false,
          code: 'RATE_LIMITED',
          message: 'Too many join attempts. Try again shortly.',
        } satisfies JoinFailureResponse,
        429,
      )
    }

    if (this.countPendingSessionsForIp(ip) >= MAX_PENDING_PER_IP) {
      return json(
        {
          ok: false,
          code: 'RATE_LIMITED',
          message: 'Too many pending sessions from this connection. Finish connecting or wait for them to expire.',
        } satisfies JoinFailureResponse,
        429,
      )
    }

    const body = await readJson(request)
    const name = typeof body === 'object' && body !== null && 'name' in body && typeof body.name === 'string' ? body.name : ''
    const color = typeof body === 'object' && body !== null && 'color' in body && typeof body.color === 'string' ? body.color : undefined
    const result = this.world.createPendingSession(name, color)
    if (!result.ok) {
      return json(
        {
          ok: false,
          code: result.code,
          message: result.message,
        } satisfies JoinFailureResponse,
        409,
      )
    }

    this.pendingSessionMeta.set(result.sessionId, {
      ip,
      createdAt: Date.now(),
    })

    return json({
      ok: true,
      sessionId: result.sessionId,
      name: result.name,
      color: result.color,
    })
  }

  private handleSocketUpgrade(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket upgrade', { status: 426 })
    }

    this.cleanupPendingSessionMeta()
    const ip = getClientIp(request)
    if (this.isRateLimited(this.connectAttemptsByIp, ip, CONNECT_RATE_LIMIT.limit, CONNECT_RATE_LIMIT.windowMs)) {
      return new Response('Too many connection attempts', { status: 429 })
    }

    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (!sessionId || !this.world.hasPendingSession(sessionId)) {
      return new Response('Unknown session', { status: 404 })
    }

    const pendingMeta = this.pendingSessionMeta.get(sessionId)
    if (pendingMeta && pendingMeta.ip !== ip) {
      return new Response('Session IP mismatch', { status: 403 })
    }

    if (this.pendingSockets.has(sessionId) || this.activeSockets.has(sessionId)) {
      return new Response('Session already connected', { status: 409 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    server.accept()
    server.addEventListener('message', (event) => {
      void this.handleSocketMessage(sessionId, server, event)
    })
    server.addEventListener('close', () => {
      void this.handleSocketClose(sessionId, server)
    })
    server.addEventListener('error', () => {
      server.close(1011, 'socket error')
    })

    this.pendingSockets.set(sessionId, server)
    return new Response(null, { status: 101, webSocket: client })
  }

  private async handleSocketMessage(sessionId: string, socket: WebSocket, event: MessageEvent): Promise<void> {
    const message = parseClientMessage(event.data)
    if (!message) {
      sendJson(socket, { type: 'move_rejected', reason: 'BAD_MESSAGE' })
      return
    }

    switch (message.type) {
      case 'join_ack': {
        if (message.sessionId !== sessionId || !this.pendingSockets.has(sessionId)) {
          socket.close(1008, 'invalid session')
          return
        }

        const activated = this.world.activateSession(sessionId)
        if (!activated.ok) {
          socket.close(1008, activated.reason)
          return
        }

        this.pendingSockets.delete(sessionId)
        const pendingMeta = this.pendingSessionMeta.get(sessionId)
        this.pendingSessionMeta.delete(sessionId)
        this.activeSockets.set(sessionId, socket)
        this.sessionThrottleState.set(sessionId, {
          ip: pendingMeta?.ip ?? getClientIpFromSocketFallback(),
          lastMoveAt: 0,
          lastRotateAt: 0,
          lastPingAt: 0,
        })
        await this.persistStandings()
        sendJson(socket, {
          type: 'session_started',
          player: activated.player,
          snapshot: activated.snapshot,
        })
        this.broadcastScoreboard(activated.leaderboard)
        return
      }

      case 'move_intent': {
        if (!this.activeSockets.has(sessionId)) {
          socket.close(1008, 'join first')
          return
        }

        if (!this.allowAction(sessionId, 'move')) {
          socket.close(1008, 'rate limited')
          return
        }

        const result = this.world.applyMove(sessionId, message.direction)
        if (!result.ok) {
          sendJson(socket, { type: 'move_rejected', reason: result.reason })
          return
        }

        await this.persistStandings()
        this.broadcastDelta(result.changedTiles, result.now, result.leaderboard)
        this.broadcastScoreboard(result.leaderboard)
        return
      }

      case 'rotate_intent': {
        if (!this.activeSockets.has(sessionId)) {
          socket.close(1008, 'join first')
          return
        }

        if (!this.allowAction(sessionId, 'rotate')) {
          socket.close(1008, 'rate limited')
          return
        }

        const result = this.world.rotatePlayer(sessionId, message.direction)
        if (!result.ok) {
          sendJson(socket, { type: 'move_rejected', reason: result.reason })
          return
        }

        this.broadcastDelta(result.changedTiles, result.now, result.leaderboard)
        return
      }

      case 'ping': {
        if (!this.allowAction(sessionId, 'ping')) {
          socket.close(1008, 'rate limited')
          return
        }

        const snapshot = this.world.getSnapshotFor(sessionId)
        if (snapshot) {
          sendJson(socket, { type: 'state_snapshot', snapshot })
        }
      }
    }
  }

  private async handleSocketClose(sessionId: string, socket: WebSocket): Promise<void> {
    if (this.pendingSockets.get(sessionId) === socket) {
      this.pendingSockets.delete(sessionId)
      this.pendingSessionMeta.delete(sessionId)
      this.world.releasePendingSession(sessionId)
      return
    }

    if (this.activeSockets.get(sessionId) !== socket) {
      return
    }

    this.activeSockets.delete(sessionId)
    this.sessionThrottleState.delete(sessionId)
    const disconnected = this.world.disconnect(sessionId)
    if (!disconnected.removed) {
      return
    }

    await this.persistStandings()
    this.broadcastDelta(disconnected.changedTiles, Date.now(), disconnected.leaderboard)
    this.broadcastScoreboard(disconnected.leaderboard)
  }

  private async flushWorld(): Promise<void> {
    if (this.activeSockets.size === 0) {
      return
    }

    const now = Date.now()
    const stepped = this.world.stepSimulation(now)
    if (stepped.changedTiles.length > 0 || stepped.changedPlayers.length > 0) {
      this.broadcastDelta(stepped.changedTiles, now, stepped.leaderboard)
      this.broadcastScoreboard(stepped.leaderboard)
    }

    for (const [sessionId, socket] of this.activeSockets) {
      const snapshot = this.world.getSnapshotFor(sessionId, now)
      if (!snapshot) {
        socket.close(1011, 'snapshot unavailable')
        continue
      }
      sendJson(socket, { type: 'state_snapshot', snapshot })
    }
  }

  private broadcastDelta(changedTiles: Array<{ x: number; z: number }>, now: number, leaderboard: ReturnType<GameWorld['getLeaderboard']>): void {
    for (const [sessionId, socket] of this.activeSockets) {
      const delta = this.world.buildDeltaFor(sessionId, changedTiles, now, leaderboard)
      if (!delta) {
        continue
      }
      if (delta.tiles.length === 0 && delta.players.length === 0) {
        continue
      }
      sendJson(socket, delta)
    }
  }

  private broadcastScoreboard(leaderboard = this.world.getLeaderboard()): void {
    for (const socket of this.activeSockets.values()) {
      sendJson(socket, { type: 'scoreboard', leaderboard })
    }
  }

  private async persistStandings(): Promise<void> {
    await this.state.storage.put(STANDINGS_STORAGE_KEY, this.world.serializeStandings())
  }

  private countPendingSessionsForIp(ip: string): number {
    let count = 0
    for (const meta of this.pendingSessionMeta.values()) {
      if (meta.ip === ip) {
        count += 1
      }
    }
    return count
  }

  private cleanupPendingSessionMeta(): void {
    const now = Date.now()
    for (const [sessionId, meta] of this.pendingSessionMeta) {
      if (now - meta.createdAt <= PENDING_TTL_MS && this.world.hasPendingSession(sessionId)) {
        continue
      }
      this.pendingSessionMeta.delete(sessionId)
    }
  }

  private isRateLimited(bucket: Map<string, number[]>, key: string, limit: number, windowMs: number): boolean {
    const now = Date.now()
    const recent = (bucket.get(key) ?? []).filter((value) => value > now - windowMs)
    recent.push(now)
    bucket.set(key, recent)
    return recent.length > limit
  }

  private allowAction(sessionId: string, type: 'move' | 'rotate' | 'ping'): boolean {
    const state = this.sessionThrottleState.get(sessionId)
    if (!state) {
      return false
    }

    const now = Date.now()
    switch (type) {
      case 'move':
        if (now - state.lastMoveAt < MOVE_MIN_INTERVAL_MS) {
          return false
        }
        state.lastMoveAt = now
        return true
      case 'rotate':
        if (now - state.lastRotateAt < ROTATE_MIN_INTERVAL_MS) {
          return false
        }
        state.lastRotateAt = now
        return true
      case 'ping':
        if (now - state.lastPingAt < PING_MIN_INTERVAL_MS) {
          return false
        }
        state.lastPingAt = now
        return true
    }
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/join' && request.method === 'POST') {
      if (!isAllowedOrigin(request)) {
        return json(
          {
            ok: false,
            code: 'FORBIDDEN_ORIGIN',
            message: 'Cross-origin join requests are not allowed.',
          } satisfies JoinFailureResponse,
          403,
        )
      }

      const stub = getWorldStub(env)
      const response = await stub.fetch(`${INTERNAL_HOST}/internal/join`, request)
      const payload = (await response.json()) as JoinResponse

      if (!payload.ok) {
        return json(payload, response.status)
      }

      const websocketUrl = new URL('/api/connect', request.url)
      websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
      websocketUrl.searchParams.set('sessionId', payload.sessionId)

      return json({
        ...payload,
        websocketUrl: websocketUrl.toString(),
      })
    }

    if (url.pathname === '/api/connect') {
      if (!isAllowedOrigin(request)) {
        return new Response('Cross-origin websocket requests are not allowed.', { status: 403 })
      }

      const stub = getWorldStub(env)
      return stub.fetch(`${INTERNAL_HOST}/internal/connect${url.search}`, request)
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

function getWorldStub(env: Env): DurableObjectStub {
  return env.WORLD.get(env.WORLD.idFromName('world'))
}

function sendJson(socket: WebSocket, payload: ServerMessage): void {
  socket.send(JSON.stringify(payload))
}

function json<T>(payload: T, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function parseClientMessage(value: unknown): ClientMessage | null {
  if (typeof value !== 'string') {
    return null
  }

  try {
    const message = JSON.parse(value) as Partial<ClientMessage>
    if (message.type === 'join_ack' && typeof message.sessionId === 'string') {
      return { type: 'join_ack', sessionId: message.sessionId }
    }
    if (
      message.type === 'move_intent' &&
      (message.direction === 'up' ||
        message.direction === 'down' ||
        message.direction === 'left' ||
        message.direction === 'right')
    ) {
      return { type: 'move_intent', direction: message.direction }
    }
    if (message.type === 'rotate_intent' && (message.direction === 'left' || message.direction === 'right')) {
      return { type: 'rotate_intent', direction: message.direction }
    }
    if (message.type === 'ping') {
      return { type: 'ping' }
    }
    return null
  } catch {
    return null
  }
}

function getClientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? request.headers.get('x-forwarded-for') ?? 'unknown'
}

function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin')
  if (!origin) {
    return true
  }

  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

function getClientIpFromSocketFallback(): string {
  return 'unknown'
}
