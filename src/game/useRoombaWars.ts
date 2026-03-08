import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_ROOMBA_COLOR,
  type Direction,
  MAX_NAME_LENGTH,
  type ClientMessage,
  type JoinFailureResponse,
  type JoinSuccessResponse,
  type LeaderboardEntry,
  type ServerMessage,
  type TurnDirection,
  type VisibleEnemy,
  type VisiblePlayer,
  type VisibleTile,
  type WorldSnapshot,
  isValidColor,
  normalizeColor,
  oppositeDirection,
} from '../../shared/protocol'

export type ConnectionStatus = 'idle' | 'joining' | 'connecting' | 'connected' | 'offline'
const NAME_STORAGE_KEY = 'roomba-wars:name'
const COLOR_STORAGE_KEY = 'roomba-wars:color'
const HOLD_MOVE_INTERVAL_MS = 120
const SWIPE_THRESHOLD_PX = 36
const SWIPE_MAX_DURATION_MS = 700

export interface GameState {
  status: ConnectionStatus
  statusLabel: string
  name: string
  color: string
  error: string | null
  moveError: string | null
  combatNotice: string | null
  now: number
  selfSessionId: string | null
  self: VisiblePlayer | null
  players: VisiblePlayer[]
  enemies: VisibleEnemy[]
  tiles: VisibleTile[]
  leaderboard: LeaderboardEntry[]
  setName: (value: string) => void
  setColor: (value: string) => void
}

const KEY_TO_DIRECTION = new Map<string, Direction>([
  ['arrowup', 'up'],
  ['w', 'up'],
  ['arrowdown', 'down'],
  ['s', 'down'],
  ['arrowleft', 'left'],
  ['a', 'left'],
  ['arrowright', 'right'],
  ['d', 'right'],
])

export function useRoombaWars(): {
  state: GameState
  joinGame: (name: string) => Promise<void>
  leaveGame: () => void
} {
  const [status, setStatus] = useState<ConnectionStatus>('idle')
  const [name, setName] = useState(() => readStoredName())
  const [color, setColor] = useState(() => readStoredColor())
  const [error, setError] = useState<string | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [combatNotice, setCombatNotice] = useState<string | null>(null)
  const [selfSessionId, setSelfSessionId] = useState<string | null>(null)
  const [players, setPlayers] = useState<VisiblePlayer[]>([])
  const [enemies, setEnemies] = useState<VisibleEnemy[]>([])
  const [tiles, setTiles] = useState<VisibleTile[]>([])
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [now, setNow] = useState(0)

  const socketRef = useRef<WebSocket | null>(null)
  const lastMoveAtRef = useRef(0)
  const selfRef = useRef<VisiblePlayer | null>(null)
  const activeInputsRef = useRef(new Map<string, number>())
  const touchStartRef = useRef<{ x: number; y: number; at: number } | null>(null)

  function applySnapshot(snapshot: WorldSnapshot): void {
    setNow(snapshot.now)
    setSelfSessionId(snapshot.selfSessionId)
    setPlayers(snapshot.players)
    setEnemies(snapshot.enemies)
    setTiles(snapshot.tiles)
    setLeaderboard(snapshot.leaderboard)
    setCombatNotice(snapshot.selfNotice?.message ?? null)
    setMoveError(null)
  }

  function applyMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'session_started':
        setStatus('connected')
        applySnapshot(message.snapshot)
        return
      case 'state_snapshot':
        applySnapshot(message.snapshot)
        return
      case 'state_delta':
        setNow(message.now)
        setPlayers(message.players)
        setEnemies(message.enemies)
        setLeaderboard(message.leaderboard)
        setCombatNotice(message.selfNotice?.message ?? null)
        if (message.tiles.length > 0) {
          setTiles((current) => mergeTiles(current, message.tiles))
        }
        return
      case 'scoreboard':
        setLeaderboard(message.leaderboard)
        return
      case 'move_rejected':
        setMoveError(humanizeMoveError(message.reason))
    }
  }

  function leaveGame(): void {
    socketRef.current?.close(1000, 'client disconnect')
    socketRef.current = null
    setStatus('idle')
    setSelfSessionId(null)
    setPlayers([])
    setEnemies([])
    setTiles([])
    setLeaderboard([])
    setMoveError(null)
    setCombatNotice(null)
  }

  useEffect(() => {
    return () => {
      socketRef.current?.close(1000, 'component unmount')
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(NAME_STORAGE_KEY, name)
  }, [name])

  useEffect(() => {
    window.localStorage.setItem(COLOR_STORAGE_KEY, color)
  }, [color])

  useEffect(() => {
    if (status !== 'connected') {
      return
    }

    const activeInputs = activeInputsRef.current

    const sendAction = (input: Direction) => {
      const currentSelf = selfRef.current
      if (!currentSelf) {
        return
      }

      if (Date.now() - lastMoveAtRef.current < HOLD_MOVE_INTERVAL_MS) {
        return
      }

      lastMoveAtRef.current = Date.now()
      socketRef.current?.send(JSON.stringify(resolveRelativeAction(currentSelf.heading, input)))
    }

    const trySendMove = () => {
      if (activeInputs.size === 0) {
        return
      }

      const input = getPreferredInput(activeInputs)
      if (!input) {
        return
      }

      sendAction(input)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const input = KEY_TO_DIRECTION.get(event.key.toLowerCase())
      if (!input) {
        return
      }

      event.preventDefault()
      activeInputs.set(event.key.toLowerCase(), performance.now())
      if (event.repeat) {
        return
      }
      trySendMove()
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (!KEY_TO_DIRECTION.has(event.key.toLowerCase())) {
        return
      }
      activeInputs.delete(event.key.toLowerCase())
    }

    const onBlur = () => {
      activeInputs.clear()
      touchStartRef.current = null
    }

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || isInteractiveTarget(event.target)) {
        touchStartRef.current = null
        return
      }

      const touch = event.touches[0]
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        at: performance.now(),
      }
    }

    const onTouchEnd = (event: TouchEvent) => {
      const start = touchStartRef.current
      touchStartRef.current = null
      if (!start || event.changedTouches.length !== 1) {
        return
      }

      const touch = event.changedTouches[0]
      const elapsed = performance.now() - start.at
      if (elapsed > SWIPE_MAX_DURATION_MS) {
        return
      }

      const deltaX = touch.clientX - start.x
      const deltaY = touch.clientY - start.y
      const input = swipeToDirection(deltaX, deltaY)
      if (!input) {
        return
      }

      event.preventDefault()
      sendAction(input)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchend', onTouchEnd, { passive: false })
    const intervalId = window.setInterval(trySendMove, 40)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchend', onTouchEnd)
      window.clearInterval(intervalId)
      activeInputs.clear()
      touchStartRef.current = null
    }
  }, [status])

  async function joinGame(rawName: string): Promise<void> {
    const trimmedName = rawName.trim().slice(0, MAX_NAME_LENGTH)
    if (!trimmedName) {
      setError('Enter a name before joining.')
      return
    }

    socketRef.current?.close(1000, 'rejoin')
    socketRef.current = null

    setStatus('joining')
    setError(null)
    setMoveError(null)

    try {
      const response = await fetch('/api/join', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: trimmedName, color }),
      })

      const payload = (await response.json()) as JoinSuccessResponse | JoinFailureResponse
      if (!payload.ok) {
        setStatus('idle')
        setError(payload.message)
        return
      }

      setColor(payload.color)
      setStatus('connecting')
      const socket = new WebSocket(payload.websocketUrl)
      socketRef.current = socket

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'join_ack', sessionId: payload.sessionId } satisfies ClientMessage))
      })

      socket.addEventListener('message', (event) => {
        try {
          applyMessage(JSON.parse(String(event.data)) as ServerMessage)
        } catch {
          setError('Received an unreadable server event.')
        }
      })

      socket.addEventListener('close', () => {
        socketRef.current = null
        setStatus((current) => (current === 'idle' ? current : 'offline'))
      })

      socket.addEventListener('error', () => {
        setError('Socket connection failed.')
      })
    } catch {
      setStatus('idle')
      setError('Join request failed.')
    }
  }

  const self = selfSessionId ? players.find((player) => player.sessionId === selfSessionId) ?? null : null

  useEffect(() => {
    selfRef.current = self
  }, [self])

  return {
    state: {
      status,
      statusLabel: statusLabels[status],
      name,
      color,
      error,
      moveError,
      combatNotice,
      now,
      selfSessionId,
      self,
      players,
      enemies,
      tiles,
      leaderboard,
      setName,
      setColor,
    },
    joinGame,
    leaveGame,
  }
}

const statusLabels: Record<ConnectionStatus, string> = {
  idle: 'idle',
  joining: 'reserving',
  connecting: 'linking',
  connected: 'live',
  offline: 'offline',
}

function mergeTiles(current: VisibleTile[], updates: VisibleTile[]): VisibleTile[] {
  const map = new Map(current.map((tile) => [`${tile.x},${tile.z}`, tile]))
  for (const tile of updates) {
    map.set(`${tile.x},${tile.z}`, tile)
  }
  return [...map.values()].sort((left, right) => (left.z === right.z ? left.x - right.x : left.z - right.z))
}

function getPreferredInput(activeInputs: Map<string, number>): Direction | null {
  let latestKey: string | null = null
  let latestAt = -1

  for (const [key, pressedAt] of activeInputs) {
    if (pressedAt > latestAt) {
      latestAt = pressedAt
      latestKey = key
    }
  }

  if (!latestKey) {
    return null
  }

  return KEY_TO_DIRECTION.get(latestKey) ?? null
}

function swipeToDirection(deltaX: number, deltaY: number): Direction | null {
  if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX && Math.abs(deltaY) < SWIPE_THRESHOLD_PX) {
    return null
  }

  if (Math.abs(deltaX) > Math.abs(deltaY)) {
    return deltaX > 0 ? 'right' : 'left'
  }

  return deltaY > 0 ? 'down' : 'up'
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, button, textarea, select, label'))
}

function humanizeMoveError(reason: string): string {
  switch (reason) {
    case 'TILE_OCCUPIED':
      return 'That dirt tile is already occupied.'
    case 'TILE_REGROWING':
      return 'That tile is still regrowing.'
    case 'TILE_EMPTY':
      return 'No dirt there. Pick another route.'
    default:
      return 'Move rejected by the arena server.'
  }
}

function resolveRelativeAction(currentHeading: Direction, input: Direction): ClientMessage {
  switch (input) {
    case 'up':
      return { type: 'move_intent', direction: currentHeading }
    case 'down':
      return { type: 'move_intent', direction: oppositeDirection(currentHeading) }
    case 'left':
      return { type: 'rotate_intent', direction: 'left' satisfies TurnDirection }
    case 'right':
      return { type: 'rotate_intent', direction: 'right' satisfies TurnDirection }
  }
}

function readStoredName(): string {
  if (typeof window === 'undefined') {
    return ''
  }

  return window.localStorage.getItem(NAME_STORAGE_KEY) ?? ''
}

function readStoredColor(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_ROOMBA_COLOR
  }

  const stored = normalizeColor(window.localStorage.getItem(COLOR_STORAGE_KEY) ?? DEFAULT_ROOMBA_COLOR)
  return isValidColor(stored) ? stored : DEFAULT_ROOMBA_COLOR
}
