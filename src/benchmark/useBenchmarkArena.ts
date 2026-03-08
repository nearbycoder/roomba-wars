import { startTransition, useEffect, useRef, useState } from 'react'
import { GameWorld } from '../../server/game-world'
import {
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
const BENCHMARK_SLOT_SPACING = 10
const BENCHMARK_SLOT_SEARCH_RADIUS = 4
const BENCHMARK_EDGE_PADDING = 6
const BENCHMARK_SPEED_STORAGE_KEY = 'roomba-wars-benchmark-speed'
const INITIAL_CAMERA_VIEW: CameraView = {
  camera: { x: 0, z: 0 },
  focus: { x: 0, z: 0 },
}

export interface BenchmarkConfig {
  botCount: number
  fieldRadius: number
  includeDustBunnies: boolean
  initialSpeed: number
  constrainToSquare: boolean
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
  bounds: BenchmarkBounds | null
  slotAnchors: Coord[]
  setNow: (value: number) => void
  getNow: () => number
}

interface BenchmarkBotBrain {
  recentKeys: string[]
  stallCount: number
  turnBias: 'left' | 'right'
}

interface BenchmarkBounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
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

  useEffect(() => {
    writeStoredBenchmarkSpeed(speed)
  }, [speed])

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
  const speedParam = params.get('speed')
  const storedSpeed = readStoredBenchmarkSpeed()
  const initialSpeed = Number.parseFloat(speedParam ?? storedSpeed ?? '1')
  const constrainToSquare = params.get('square') === '1'

  return {
    botCount: Number.isFinite(bots) ? clamp(bots, 1, 400) : 100,
    fieldRadius: Number.isFinite(fieldRadius) ? clamp(fieldRadius, 12, 40) : 22,
    includeDustBunnies,
    initialSpeed: Number.isFinite(initialSpeed) ? clamp(initialSpeed, 0, 4) : 1,
    constrainToSquare,
  }
}

function readStoredBenchmarkSpeed(): string | null {
  try {
    return window.localStorage.getItem(BENCHMARK_SPEED_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredBenchmarkSpeed(speed: number): void {
  try {
    window.localStorage.setItem(BENCHMARK_SPEED_STORAGE_KEY, speed.toString())
  } catch {
    // Ignore storage failures so the benchmark still works in restricted browsers.
  }
}

function createBenchmarkRuntime(config: BenchmarkConfig): BenchmarkRuntime {
  let currentNow = performance.now()
  const world = new GameWorld({
    now: () => currentNow,
    disableEnemies: !config.includeDustBunnies,
    regrowMinMs: 5_000,
    regrowMaxMs: 5_000,
  })
  const sessionIds: string[] = []
  const botBrains = new Map<string, BenchmarkBotBrain>()
  const squareLayout = config.constrainToSquare ? createCenteredBenchmarkSquareLayout(config.botCount) : null

  for (let index = 0; index < config.botCount; index += 1) {
    const joined = world.createPendingSession(`Benchmark Bot ${index + 1}`, benchmarkColorForIndex(index))
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

  if (squareLayout) {
    packBenchmarkPlayersIntoBounds(world, sessionIds, squareLayout.bounds, squareLayout.slotAnchors, currentNow)
    clearBenchmarkEnemies(world)
    if (config.includeDustBunnies) {
      world.stepSimulation(currentNow)
    }
  }

  return {
    world,
    sessionIds,
    botBrains,
    bounds: squareLayout?.bounds ?? null,
    slotAnchors: squareLayout?.slotAnchors ?? [],
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
  ensureBenchmarkPlayersStayWithinBounds(runtime, now)

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
      if (!isInsideBenchmarkBounds(destination, runtime.bounds)) {
        return null
      }
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
    if (!isInsideBenchmarkBounds(destination, runtime.bounds)) {
      continue
    }
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
      if (!isInsideBenchmarkBounds(next, runtime.bounds)) {
        continue
      }
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
    if (!isInsideBenchmarkBounds(next, runtime.bounds)) {
      continue
    }
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

function createCenteredBenchmarkSquareLayout(botCount: number): { bounds: BenchmarkBounds; slotAnchors: Coord[] } {
  const columns = Math.max(1, Math.ceil(Math.sqrt(botCount)))
  const rows = Math.max(1, Math.ceil(botCount / columns))
  const width = (columns - 1) * BENCHMARK_SLOT_SPACING
  const height = (rows - 1) * BENCHMARK_SLOT_SPACING
  const startX = -Math.floor(width / 2)
  const startZ = -Math.floor(height / 2)
  const slotAnchors: Coord[] = []

  for (let index = 0; index < botCount; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    slotAnchors.push({
      x: startX + column * BENCHMARK_SLOT_SPACING,
      z: startZ + row * BENCHMARK_SLOT_SPACING,
    })
  }

  return {
    bounds: {
      minX: startX - BENCHMARK_EDGE_PADDING,
      maxX: startX + width + BENCHMARK_EDGE_PADDING,
      minZ: startZ - BENCHMARK_EDGE_PADDING,
      maxZ: startZ + height + BENCHMARK_EDGE_PADDING,
    },
    slotAnchors,
  }
}

function benchmarkColorForIndex(index: number): string {
  const hue = (index * 137.508) % 360
  const saturation = 84 + ((index * 17) % 12)
  const lightness = 62 + ((index * 29) % 8)
  return hslToHex(hue, saturation, lightness)
}

function isInsideBenchmarkBounds(coord: Coord, bounds: BenchmarkBounds | null): boolean {
  if (!bounds) {
    return true
  }

  return coord.x >= bounds.minX && coord.x <= bounds.maxX && coord.z >= bounds.minZ && coord.z <= bounds.maxZ
}

function packBenchmarkPlayersIntoBounds(
  world: GameWorld,
  sessionIds: string[],
  bounds: BenchmarkBounds,
  slotAnchors: Coord[],
  now: number,
): void {
  const internal = world as unknown as {
    players: Map<string, { x: number; z: number }>
    occupiedTiles: Map<string, string>
  }
  const originalPositions = new Map<string, Coord>()

  for (const sessionId of sessionIds) {
    const player = internal.players.get(sessionId)
    if (!player) {
      continue
    }
    originalPositions.set(sessionId, { x: player.x, z: player.z })
    internal.occupiedTiles.delete(coordKey(player.x, player.z))
  }

  const slots = collectBenchmarkSlots(world, bounds, slotAnchors, now)

  for (const sessionId of sessionIds) {
    const player = internal.players.get(sessionId)
    const slot = slots.shift()
    if (!player) {
      continue
    }
    if (!slot) {
      const original = originalPositions.get(sessionId)
      if (original) {
        internal.occupiedTiles.set(coordKey(original.x, original.z), sessionId)
      }
      continue
    }

    player.x = slot.x
    player.z = slot.z
    internal.occupiedTiles.set(coordKey(slot.x, slot.z), sessionId)
  }
}

function ensureBenchmarkPlayersStayWithinBounds(runtime: BenchmarkRuntime, now: number): void {
  if (!runtime.bounds) {
    return
  }

  const internal = runtime.world as unknown as {
    players: Map<string, { x: number; z: number }>
    occupiedTiles: Map<string, string>
  }
  const sessionsToRelocate = runtime.sessionIds.filter((sessionId) => {
    const player = internal.players.get(sessionId)
    return player ? !isInsideBenchmarkBounds(player, runtime.bounds) : false
  })

  if (sessionsToRelocate.length === 0) {
    return
  }

  const originalPositions = new Map<string, Coord>()
  for (const sessionId of sessionsToRelocate) {
    const player = internal.players.get(sessionId)
    if (!player) {
      continue
    }
    originalPositions.set(sessionId, { x: player.x, z: player.z })
    internal.occupiedTiles.delete(coordKey(player.x, player.z))
  }

  const openSlots = collectBenchmarkSlots(runtime.world, runtime.bounds, runtime.slotAnchors, now)

  for (const sessionId of sessionsToRelocate) {
    const player = internal.players.get(sessionId)
    if (!player) {
      continue
    }

    const slot = openSlots.shift()
    if (!slot) {
      const original = originalPositions.get(sessionId)
      if (original) {
        internal.occupiedTiles.set(coordKey(original.x, original.z), sessionId)
      }
      continue
    }

    player.x = slot.x
    player.z = slot.z
    internal.occupiedTiles.set(coordKey(slot.x, slot.z), sessionId)
  }
}

function clearBenchmarkEnemies(world: GameWorld): void {
  const internal = world as unknown as {
    enemies: Map<string, { x: number; z: number }>
    occupiedTiles: Map<string, string>
  }

  for (const [enemyId, enemy] of internal.enemies) {
    internal.occupiedTiles.delete(coordKey(enemy.x, enemy.z))
    internal.enemies.delete(enemyId)
  }
}

function collectBenchmarkSlots(world: GameWorld, bounds: BenchmarkBounds, slotAnchors: Coord[], now: number): Coord[] {
  const internal = world as unknown as { occupiedTiles: Map<string, string> }
  const reserved = new Set<string>()
  const coords: Coord[] = []

  for (const anchor of slotAnchors) {
    const slot = findBenchmarkSlotNearAnchor(world, bounds, anchor, now, internal.occupiedTiles, reserved, coords)
    if (!slot) {
      continue
    }
    reserved.add(coordKey(slot.x, slot.z))
    coords.push(slot)
  }

  if (coords.length >= slotAnchors.length) {
    return coords
  }

  for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const key = coordKey(x, z)
      if (reserved.has(key) || internal.occupiedTiles.has(key)) {
        continue
      }
      if (world.getTileState(x, z, now) !== 'dirt') {
        continue
      }
      const candidate = { x, z }
      if (!isFarEnoughFromReserved(candidate, coords)) {
        continue
      }
      coords.push(candidate)
    }
  }

  return coords
}

function findBenchmarkSlotNearAnchor(
  world: GameWorld,
  bounds: BenchmarkBounds,
  anchor: Coord,
  now: number,
  occupiedTiles: Map<string, string>,
  reserved: Set<string>,
  reservedCoords: Coord[],
): Coord | null {
  let best: Coord | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (let z = anchor.z - BENCHMARK_SLOT_SEARCH_RADIUS; z <= anchor.z + BENCHMARK_SLOT_SEARCH_RADIUS; z += 1) {
    for (let x = anchor.x - BENCHMARK_SLOT_SEARCH_RADIUS; x <= anchor.x + BENCHMARK_SLOT_SEARCH_RADIUS; x += 1) {
      const candidate = { x, z }
      if (!isInsideBenchmarkBounds(candidate, bounds)) {
        continue
      }

      const key = coordKey(x, z)
      if (reserved.has(key) || occupiedTiles.has(key) || world.getTileState(x, z, now) !== 'dirt') {
        continue
      }
      if (!isFarEnoughFromReserved(candidate, reservedCoords)) {
        continue
      }

      const distance = Math.abs(anchor.x - x) + Math.abs(anchor.z - z)
      if (distance < bestDistance) {
        best = candidate
        bestDistance = distance
      }
    }
  }

  return best
}

function isFarEnoughFromReserved(candidate: Coord, reservedCoords: Coord[]): boolean {
  for (const reserved of reservedCoords) {
    const dx = candidate.x - reserved.x
    const dz = candidate.z - reserved.z
    if (dx * dx + dz * dz < BENCHMARK_SLOT_SPACING * BENCHMARK_SLOT_SPACING) {
      return false
    }
  }
  return true
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100
  const l = lightness / 100
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const segment = hue / 60
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1))
  let red = 0
  let green = 0
  let blue = 0

  if (segment >= 0 && segment < 1) {
    red = chroma
    green = secondary
  } else if (segment < 2) {
    red = secondary
    green = chroma
  } else if (segment < 3) {
    green = chroma
    blue = secondary
  } else if (segment < 4) {
    green = secondary
    blue = chroma
  } else if (segment < 5) {
    red = secondary
    blue = chroma
  } else {
    red = chroma
    blue = secondary
  }

  const match = l - chroma / 2
  return rgbToHex(red + match, green + match, blue + match)
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`
}

function toHex(channel: number): string {
  return Math.round(clamp(channel, 0, 1) * 255)
    .toString(16)
    .padStart(2, '0')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
