import { startTransition, useEffect, useRef, useState } from 'react'
import { GameWorld } from '../../server/game-world'
import {
  DEFAULT_ROOMBA_COLOR,
  DIRECTIONS,
  VIEW_RADIUS_TILES,
  coordKey,
  oppositeDirection,
  rotateLeft,
  rotateRight,
  type Coord,
  type Direction,
  type LeaderboardEntry,
  type VisibleEnemy,
  type VisiblePlayer,
  type VisibleTile,
} from '../../shared/protocol'

const STEP_MS = 100
const COLORS = ['#ef8354', '#4f5d75', '#2d6a4f', '#e09f3e', '#3d5a80', '#d62828', '#6d597a', '#1d3557']
const INITIAL_CAMERA_VIEW: CameraView = {
  camera: { x: 0, z: 0 },
  focus: { x: 0, z: 0 },
}

export interface BenchmarkConfig {
  botCount: number
  fieldRadius: number
  includeDustBunnies: boolean
  initialSpeed: number
}

export interface BenchmarkStats {
  currentFps: number
  averageFps: number
  minFps: number
}

export interface BenchmarkSnapshot {
  players: VisiblePlayer[]
  enemies: VisibleEnemy[]
  tiles: VisibleTile[]
  leaderboard: LeaderboardEntry[]
}

export interface CameraFocus {
  x: number
  z: number
}

export interface CameraView {
  camera: CameraFocus
  focus: CameraFocus
}

interface BenchmarkRuntime {
  world: GameWorld
  sessionIds: string[]
  botBrains: Map<string, BenchmarkBotBrain>
  setNow: (value: number) => void
  getNow: () => number
}

interface BenchmarkBotBrain {
  recentKeys: string[]
  stallCount: number
  turnBias: 'left' | 'right'
}

export function useBenchmarkArena(config: BenchmarkConfig) {
  const [runtime] = useState(() => createBenchmarkRuntime(config))
  const [speed, setSpeed] = useState(config.initialSpeed)
  const cameraViewRef = useRef<CameraView>(INITIAL_CAMERA_VIEW)
  const [snapshot, setSnapshot] = useState<BenchmarkSnapshot>(() => captureSnapshot(runtime, config.fieldRadius, INITIAL_CAMERA_VIEW))
  const [sceneNow, setSceneNow] = useState(() => runtime.getNow())
  const [stats, setStats] = useState<BenchmarkStats>({
    currentFps: 0,
    averageFps: 0,
    minFps: 0,
  })

  useEffect(() => {
    let frameId = 0
    let lastFrameAt = performance.now()
    let simulatedNow = runtime.getNow()
    let lastStepAt = simulatedNow
    let frameCount = 0
    let windowStart = performance.now()
    const fpsSamples: number[] = []
    let lastCameraX = Math.round(cameraViewRef.current.camera.x)
    let lastCameraZ = Math.round(cameraViewRef.current.camera.z)
    let lastFocusX = Math.round(cameraViewRef.current.focus.x)
    let lastFocusZ = Math.round(cameraViewRef.current.focus.z)

    const tick = (now: number) => {
      const realElapsed = now - lastFrameAt
      lastFrameAt = now

      // Keep the benchmark deterministic enough for movement testing while still
      // allowing the UI slider to speed up or slow down the local simulation.
      const scaledElapsed = Math.min(realElapsed * speed, STEP_MS * 8)
      simulatedNow += scaledElapsed

      let stepped = false
      while (simulatedNow - lastStepAt >= STEP_MS) {
        lastStepAt += STEP_MS
        runtime.setNow(lastStepAt)
        stepBenchmarkWorld(runtime, lastStepAt)
        stepped = true
      }

      const nextCameraX = Math.round(cameraViewRef.current.camera.x)
      const nextCameraZ = Math.round(cameraViewRef.current.camera.z)
      const nextFocusX = Math.round(cameraViewRef.current.focus.x)
      const nextFocusZ = Math.round(cameraViewRef.current.focus.z)
      const cameraMoved =
        nextCameraX !== lastCameraX ||
        nextCameraZ !== lastCameraZ ||
        nextFocusX !== lastFocusX ||
        nextFocusZ !== lastFocusZ

      // The floor snapshot follows the free camera even when the simulation is paused.
      if (stepped || cameraMoved) {
        lastCameraX = nextCameraX
        lastCameraZ = nextCameraZ
        lastFocusX = nextFocusX
        lastFocusZ = nextFocusZ
        const nextSnapshot = captureSnapshot(runtime, config.fieldRadius, cameraViewRef.current)
        startTransition(() => {
          setSnapshot(nextSnapshot)
          setSceneNow(lastStepAt)
        })
      }

      frameCount += 1
      const elapsed = now - windowStart
      if (elapsed >= 500) {
        const currentFps = Math.round((frameCount * 1000) / elapsed)
        fpsSamples.push(currentFps)
        if (fpsSamples.length > 24) {
          fpsSamples.shift()
        }

        startTransition(() => {
          setStats({
            currentFps,
            averageFps: Math.round(fpsSamples.reduce((sum, value) => sum + value, 0) / fpsSamples.length),
            minFps: Math.min(...fpsSamples),
          })
        })
        frameCount = 0
        windowStart = now
      }

      frameId = window.requestAnimationFrame(tick)
    }

    frameId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frameId)
  }, [config.fieldRadius, runtime, speed])

  return {
    sceneNow,
    self: snapshot.players[0] ?? null,
    snapshot,
    speed,
    stats,
    setSpeed,
    setCameraFocus(view: CameraView) {
      cameraViewRef.current = view
    },
  }
}

export function readBenchmarkConfig(): BenchmarkConfig {
  const params = new URLSearchParams(window.location.search)
  const bots = Number.parseInt(params.get('bots') ?? '100', 10)
  const fieldRadius = Number.parseInt(params.get('field') ?? '22', 10)
  const includeDustBunnies = params.get('bunnies') === '1'
  const initialSpeed = Number.parseFloat(params.get('speed') ?? '1')

  return {
    botCount: Number.isFinite(bots) ? clamp(bots, 1, 400) : 100,
    fieldRadius: Number.isFinite(fieldRadius) ? clamp(fieldRadius, 12, 40) : 22,
    includeDustBunnies,
    initialSpeed: Number.isFinite(initialSpeed) ? clamp(initialSpeed, 0, 4) : 1,
  }
}

function createBenchmarkRuntime(config: BenchmarkConfig): BenchmarkRuntime {
  let currentNow = performance.now()
  const world = new GameWorld({
    now: () => currentNow,
    disableEnemies: !config.includeDustBunnies,
  })
  const sessionIds: string[] = []
  const botBrains = new Map<string, BenchmarkBotBrain>()

  for (let index = 0; index < config.botCount; index += 1) {
    const joined = world.createPendingSession(`Benchmark Bot ${index + 1}`, COLORS[index % COLORS.length] ?? DEFAULT_ROOMBA_COLOR)
    if (!joined.ok) {
      continue
    }

    const activated = world.activateSession(joined.sessionId)
    if (!activated.ok) {
      continue
    }

    sessionIds.push(joined.sessionId)
    botBrains.set(joined.sessionId, {
      recentKeys: [],
      stallCount: 0,
      turnBias: index % 2 === 0 ? 'right' : 'left',
    })
  }

  return {
    world,
    sessionIds,
    botBrains,
    setNow(value: number) {
      currentNow = value
    },
    getNow() {
      return currentNow
    },
  }
}

function stepBenchmarkWorld(runtime: BenchmarkRuntime, now: number): void {
  runtime.world.stepSimulation(now)

  runtime.sessionIds.forEach((sessionId, index) => {
    const player = runtime.world.getPlayer(sessionId)
    const brain = runtime.botBrains.get(sessionId)
    if (!player || !brain) {
      return
    }

    const bestDirection = chooseBenchmarkMove(runtime, player, brain, now, index)
    if (bestDirection) {
      const destination = stepCoord(player, bestDirection)
      const result = runtime.world.applyMove(sessionId, bestDirection)
      if (result.ok) {
        recordBotMove(brain, destination.x, destination.z)
        brain.stallCount = 0
        return
      }
    }

    const turnDirection = chooseBenchmarkTurn(runtime, player, brain, now, index)
    runtime.world.rotatePlayer(sessionId, turnDirection)
    brain.stallCount += 1
    brain.turnBias = turnDirection === 'left' ? 'right' : 'left'
  })
}

function captureSnapshot(runtime: BenchmarkRuntime, fieldRadius: number, view: CameraView): BenchmarkSnapshot {
  const players = runtime.sessionIds
    .map((sessionId) => runtime.world.getPlayer(sessionId))
    .filter((player): player is VisiblePlayer => player !== null)

  const tiles: VisibleTile[] = []
  const now = runtime.getNow()
  const padding = Math.max(fieldRadius, VIEW_RADIUS_TILES)
  const cameraX = Math.round(view.camera.x)
  const cameraZ = Math.round(view.camera.z)
  const focusX = Math.round(view.focus.x)
  const focusZ = Math.round(view.focus.z)
  const minX = Math.min(cameraX, focusX) - padding
  const maxX = Math.max(cameraX, focusX) + padding
  const minZ = Math.min(cameraZ, focusZ) - padding
  const maxZ = Math.max(cameraZ, focusZ) + padding

  for (let z = minZ; z <= maxZ; z += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      tiles.push(runtime.world.getTileAt(x, z, now))
    }
  }

  return {
    players,
    enemies: runtime.world.getEnemies(),
    tiles,
    leaderboard: runtime.world.getLeaderboard(),
  }
}

function chooseBenchmarkMove(
  runtime: BenchmarkRuntime,
  player: VisiblePlayer,
  brain: BenchmarkBotBrain,
  now: number,
  seed: number,
): Direction | null {
  const occupied = getOccupiedPlayerTiles(runtime, player.sessionId)
  const directionOrder = getDirectionOrder(player.heading, brain.turnBias, seed)
  const scoredMoves = directionOrder
    .map((direction, orderIndex) => {
      const destination = stepCoord(player, direction)
      const key = coordKey(destination.x, destination.z)
      if (occupied.has(key)) {
        return null
      }

      const tile = runtime.world.getTileAt(destination.x, destination.z, now)
      if (tile.state !== 'dirt') {
        return null
      }

      const futureBlocked = new Set(occupied)
      futureBlocked.add(coordKey(player.x, player.z))
      const exits = countOpenNeighbors(runtime, destination, now, futureBlocked)
      const reachable = estimateReachableArea(runtime, destination, now, futureBlocked, brain.stallCount >= 2 ? 5 : 3)
      const revisitPenalty = countRecentVisits(brain.recentKeys, key) * 10
      const reversePenalty = direction === oppositeDirection(player.heading) ? 4 : 0
      const turnPenalty = direction === player.heading ? 0 : direction === oppositeDirection(player.heading) ? 3 : 1
      const trapPenalty = exits <= 1 && reachable <= 2 ? 18 : 0
      const tieBreak = orderIndex * 0.1

      return {
        direction,
        // Prefer moves that preserve future exits and reachable dirt while
        // pushing bots away from small loops and dead-end regrow traps.
        score: reachable * 5 + exits * 7 - revisitPenalty - reversePenalty - turnPenalty - trapPenalty - tieBreak,
      }
    })
    .filter((candidate): candidate is { direction: Direction; score: number } => candidate !== null)
    .sort((left, right) => right.score - left.score)

  return scoredMoves[0]?.direction ?? null
}

function chooseBenchmarkTurn(
  runtime: BenchmarkRuntime,
  player: VisiblePlayer,
  brain: BenchmarkBotBrain,
  now: number,
  seed: number,
): 'left' | 'right' {
  const occupied = getOccupiedPlayerTiles(runtime, player.sessionId)
  const leftScore = scoreFacing(runtime, player, rotateLeft(player.heading), now, occupied, brain, seed)
  const rightScore = scoreFacing(runtime, player, rotateRight(player.heading), now, occupied, brain, seed + 1)

  if (leftScore === rightScore) {
    return brain.turnBias
  }

  return leftScore > rightScore ? 'left' : 'right'
}

function scoreFacing(
  runtime: BenchmarkRuntime,
  player: VisiblePlayer,
  heading: Direction,
  now: number,
  occupied: Set<string>,
  brain: BenchmarkBotBrain,
  seed: number,
): number {
  const order = getDirectionOrder(heading, brain.turnBias, seed)
  let best = -Infinity

  for (let index = 0; index < order.length; index += 1) {
    const direction = order[index]
    const destination = stepCoord(player, direction)
    const key = coordKey(destination.x, destination.z)
    if (occupied.has(key)) {
      continue
    }

    const tile = runtime.world.getTileAt(destination.x, destination.z, now)
    const revisitPenalty = countRecentVisits(brain.recentKeys, key) * 6
    if (tile.state !== 'dirt') {
      best = Math.max(best, tile.state === 'regrowing' ? -8 - revisitPenalty : -14 - revisitPenalty)
      continue
    }

    const futureBlocked = new Set(occupied)
    futureBlocked.add(coordKey(player.x, player.z))
    const exits = countOpenNeighbors(runtime, destination, now, futureBlocked)
    const reachable = estimateReachableArea(runtime, destination, now, futureBlocked, 3)
    best = Math.max(best, reachable * 4 + exits * 5 - revisitPenalty - index * 0.1)
  }

  return best
}

function getDirectionOrder(heading: Direction, turnBias: 'left' | 'right', seed: number): Direction[] {
  const parity = seed % 2 === 0
  if ((turnBias === 'right' && parity) || (turnBias === 'left' && !parity)) {
    return [heading, rotateRight(heading), rotateLeft(heading), oppositeDirection(heading)]
  }
  return [heading, rotateLeft(heading), rotateRight(heading), oppositeDirection(heading)]
}

function recordBotMove(brain: BenchmarkBotBrain, x: number, z: number): void {
  brain.recentKeys.push(coordKey(x, z))
  if (brain.recentKeys.length > 10) {
    brain.recentKeys.shift()
  }
}

function countRecentVisits(recentKeys: string[], targetKey: string): number {
  let count = 0
  for (const key of recentKeys) {
    if (key === targetKey) {
      count += 1
    }
  }
  return count
}

function estimateReachableArea(
  runtime: BenchmarkRuntime,
  start: Coord,
  now: number,
  blocked: Set<string>,
  depthLimit: number,
): number {
  const queue: Array<{ coord: Coord; depth: number }> = [{ coord: start, depth: 0 }]
  const visited = new Set<string>([coordKey(start.x, start.z)])
  let score = 0

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) {
      continue
    }

    score += depthLimit - current.depth + 1
    if (current.depth >= depthLimit) {
      continue
    }

    for (const direction of Object.keys(DIRECTIONS) as Direction[]) {
      const next = stepCoord(current.coord, direction)
      const key = coordKey(next.x, next.z)
      if (visited.has(key) || blocked.has(key)) {
        continue
      }

      const tile = runtime.world.getTileAt(next.x, next.z, now)
      if (tile.state !== 'dirt') {
        continue
      }

      visited.add(key)
      queue.push({ coord: next, depth: current.depth + 1 })
    }
  }

  return score
}

function countOpenNeighbors(runtime: BenchmarkRuntime, origin: Coord, now: number, blocked: Set<string>): number {
  let count = 0
  for (const direction of Object.keys(DIRECTIONS) as Direction[]) {
    const next = stepCoord(origin, direction)
    const key = coordKey(next.x, next.z)
    if (blocked.has(key)) {
      continue
    }

    if (runtime.world.getTileAt(next.x, next.z, now).state === 'dirt') {
      count += 1
    }
  }
  return count
}

function getOccupiedPlayerTiles(runtime: BenchmarkRuntime, selfSessionId: string): Set<string> {
  const occupied = new Set<string>()
  for (const sessionId of runtime.sessionIds) {
    if (sessionId === selfSessionId) {
      continue
    }

    const player = runtime.world.getPlayer(sessionId)
    if (!player) {
      continue
    }

    occupied.add(coordKey(player.x, player.z))
  }
  return occupied
}

function stepCoord(origin: Coord, direction: Direction): Coord {
  const vector = DIRECTIONS[direction]
  return {
    x: origin.x + vector.x,
    z: origin.z + vector.z,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
