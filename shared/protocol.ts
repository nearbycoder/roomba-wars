export const CHUNK_SIZE = 32
export const VIEW_RADIUS_TILES = 15
export const HEARTBEAT_MS = 250
export const REGROW_MIN_MS = 30_000
export const REGROW_MAX_MS = 60_000
export const MAX_NAME_LENGTH = 20
export const DEFAULT_ROOMBA_COLOR = '#24344f'
export const DIRT_DENSITY = 0.82
export const PENDING_TTL_MS = 15_000
export const MAX_PLAYER_HEALTH = 3
export const DUST_BUNNY_HEALTH = 2
export const DUST_BUNNY_STEP_MS = 750
export const MAX_DUST_BUNNIES = 24

export type Direction = 'up' | 'down' | 'left' | 'right'
export type TurnDirection = 'left' | 'right'
export type TileState = 'dirt' | 'regrowing' | 'void'
export type JoinErrorCode = 'INVALID_NAME' | 'NAME_TAKEN' | 'INVALID_COLOR' | 'RATE_LIMITED' | 'FORBIDDEN_ORIGIN'

export interface Coord {
  x: number
  z: number
}

export interface VisibleTile extends Coord {
  state: TileState
  regrowAt?: number
}

export interface VisiblePlayer extends Coord {
  sessionId: string
  name: string
  score: number
  health: number
  color: string
  heading: Direction
}

export interface VisibleEnemy extends Coord {
  enemyId: string
  kind: 'dust-bunny'
  health: number
  heading: Direction
}

export interface CombatNotice {
  message: string
  tone: 'warning' | 'success'
  expiresAt: number
}

export interface LeaderboardEntry {
  sessionId: string
  name: string
  score: number
  color: string
  active: boolean
}

export interface WorldSnapshot {
  selfSessionId: string
  now: number
  viewRadius: number
  tiles: VisibleTile[]
  players: VisiblePlayer[]
  enemies: VisibleEnemy[]
  leaderboard: LeaderboardEntry[]
  selfNotice: CombatNotice | null
}

export type ClientMessage =
  | {
      type: 'join_ack'
      sessionId: string
    }
  | {
      type: 'move_intent'
      direction: Direction
    }
  | {
      type: 'rotate_intent'
      direction: TurnDirection
    }
  | {
      type: 'ping'
    }

export type ServerMessage =
  | {
      type: 'session_started'
      player: VisiblePlayer
      snapshot: WorldSnapshot
    }
  | {
      type: 'state_snapshot'
      snapshot: WorldSnapshot
    }
  | {
      type: 'state_delta'
      now: number
      players: VisiblePlayer[]
      enemies: VisibleEnemy[]
      tiles: VisibleTile[]
      leaderboard: LeaderboardEntry[]
      selfNotice: CombatNotice | null
    }
  | {
      type: 'move_rejected'
      reason: string
    }
  | {
      type: 'scoreboard'
      leaderboard: LeaderboardEntry[]
    }

export interface JoinSuccessResponse {
  ok: true
  name: string
  color: string
  sessionId: string
  websocketUrl: string
}

export interface JoinFailureResponse {
  ok: false
  code: JoinErrorCode
  message: string
}

export type JoinResponse = JoinSuccessResponse | JoinFailureResponse

export const DIRECTIONS: Record<Direction, Coord> = {
  up: { x: 0, z: -1 },
  down: { x: 0, z: 1 },
  left: { x: -1, z: 0 },
  right: { x: 1, z: 0 },
}

export function coordKey(x: number, z: number): string {
  return `${x},${z}`
}

export function canonicalName(value: string): string {
  return value.trim().toLocaleLowerCase()
}

export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function isValidName(value: string): boolean {
  return value.length >= 1 && value.length <= MAX_NAME_LENGTH && /^[\p{L}\p{N} _-]+$/u.test(value)
}

export function normalizeColor(value: string): string {
  return value.trim().toLowerCase()
}

export function isValidColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value)
}

export function chunkCoord(value: number): number {
  return Math.floor(value / CHUNK_SIZE)
}

export function rotateLeft(direction: Direction): Direction {
  switch (direction) {
    case 'up':
      return 'left'
    case 'left':
      return 'down'
    case 'down':
      return 'right'
    case 'right':
      return 'up'
  }
}

export function rotateRight(direction: Direction): Direction {
  switch (direction) {
    case 'up':
      return 'right'
    case 'right':
      return 'down'
    case 'down':
      return 'left'
    case 'left':
      return 'up'
  }
}

export function oppositeDirection(direction: Direction): Direction {
  switch (direction) {
    case 'up':
      return 'down'
    case 'down':
      return 'up'
    case 'left':
      return 'right'
    case 'right':
      return 'left'
  }
}
