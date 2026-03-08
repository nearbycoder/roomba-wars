import {
  CHUNK_SIZE,
  DEFAULT_ROOMBA_COLOR,
  DIRT_DENSITY,
  DIRECTIONS,
  DUST_BUNNY_HEALTH,
  DUST_BUNNY_STEP_MS,
  MAX_DUST_BUNNIES,
  MAX_NAME_LENGTH,
  MAX_PLAYER_HEALTH,
  PENDING_TTL_MS,
  REGROW_MAX_MS,
  REGROW_MIN_MS,
  VIEW_RADIUS_TILES,
  rotateLeft,
  rotateRight,
  canonicalName,
  chunkCoord,
  coordKey,
  isValidColor,
  isValidName,
  normalizeColor,
  normalizeName,
  type CombatNotice,
  type Coord,
  type Direction,
  type JoinErrorCode,
  type LeaderboardEntry,
  type TileState,
  type TurnDirection,
  type VisibleEnemy,
  type VisiblePlayer,
  type VisibleTile,
  type WorldSnapshot,
} from '../shared/protocol'

const CHUNK_SEARCH_RADIUS = 8
const DUST_BUNNY_SPAWN_RADIUS = 8
const DUST_BUNNY_MIN_PLAYER_SPAWN_DISTANCE = 5
const DUST_BUNNY_MIN_ENEMY_SPAWN_DISTANCE = 4
const DUST_BUNNY_AGGRO_RADIUS = 8
const PLAYER_SPAWN_SAFE_RADIUS = 2
const NOTICE_TTL_MS = 2_500

interface PendingSession {
  sessionId: string
  name: string
  normalizedName: string
  color: string
  createdAt: number
}

interface PlayerState extends PendingSession, Coord {
  score: number
  health: number
  heading: Direction
  notice: CombatNotice | null
}

interface EnemyState extends Coord {
  enemyId: string
  kind: 'dust-bunny'
  health: number
  heading: Direction
}

interface RegrowingTile extends Coord {
  regrowAt: number
}

export interface PersistedStanding {
  normalizedName: string
  name: string
  color: string
  score: number
  updatedAt: number
}

interface StandingState extends PersistedStanding {
  active: boolean
  sessionId: string | null
}

interface SpawnCandidate {
  spawn: Coord
  crowd: number
  sectorCrowd: number
  distance: number
  nearestDistance: number
}

interface SimulationResult {
  changedTiles: Coord[]
  changedPlayers: string[]
  leaderboard: LeaderboardEntry[]
}

interface GameWorldOptions {
  now?: () => number
  random?: () => number
  disableEnemies?: boolean
  regrowMinMs?: number
  regrowMaxMs?: number
}

export interface CreatePendingSuccess {
  ok: true
  sessionId: string
  name: string
  color: string
}

export interface CreatePendingFailure {
  ok: false
  code: JoinErrorCode
  message: string
}

export type CreatePendingResult = CreatePendingSuccess | CreatePendingFailure

export type ActivationResult =
  | {
      ok: true
      player: VisiblePlayer
      snapshot: WorldSnapshot
      leaderboard: LeaderboardEntry[]
    }
  | {
      ok: false
      reason: string
    }

export type MoveResult =
  | {
      ok: true
      now: number
      changedTiles: Coord[]
      changedPlayers: string[]
      leaderboard: LeaderboardEntry[]
      player: VisiblePlayer
    }
  | {
      ok: false
      reason: string
    }

export interface DisconnectResult {
  removed: boolean
  changedTiles: Coord[]
  changedPlayers: string[]
  leaderboard: LeaderboardEntry[]
}

export class GameWorld {
  private readonly players = new Map<string, PlayerState>()
  private readonly enemies = new Map<string, EnemyState>()
  private readonly pendingSessions = new Map<string, PendingSession>()
  private readonly standings = new Map<string, StandingState>()
  private readonly activeNames = new Map<string, string>()
  private readonly occupiedTiles = new Map<string, string>()
  private readonly regrowingTiles = new Map<string, RegrowingTile>()
  private readonly now: () => number
  private readonly random: () => number
  private readonly disableEnemies: boolean
  private readonly regrowMinMs: number
  private readonly regrowMaxMs: number
  private lastEnemyStepAt = 0

  constructor(options: GameWorldOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.random = options.random ?? Math.random
    this.disableEnemies = options.disableEnemies ?? false
    this.regrowMinMs = options.regrowMinMs ?? REGROW_MIN_MS
    this.regrowMaxMs = options.regrowMaxMs ?? REGROW_MAX_MS
  }

  createPendingSession(rawName: string, rawColor = DEFAULT_ROOMBA_COLOR): CreatePendingResult {
    const now = this.now()
    this.cleanupStalePending(now)

    const name = normalizeName(rawName)
    if (!isValidName(name) || name.length > MAX_NAME_LENGTH) {
      return {
        ok: false,
        code: 'INVALID_NAME',
        message: 'Names must be 1 to 20 characters using letters, numbers, spaces, underscores, or hyphens.',
      }
    }

    const color = normalizeColor(rawColor)
    if (!isValidColor(color)) {
      return {
        ok: false,
        code: 'INVALID_COLOR',
        message: 'Choose a valid roomba color.',
      }
    }

    const normalizedName = canonicalName(name)
    if (this.activeNames.has(normalizedName)) {
      return {
        ok: false,
        code: 'NAME_TAKEN',
        message: 'That name is already active in the arena.',
      }
    }

    const sessionId = crypto.randomUUID()
    const pending: PendingSession = {
      sessionId,
      name,
      normalizedName,
      color,
      createdAt: now,
    }

    this.pendingSessions.set(sessionId, pending)
    this.activeNames.set(normalizedName, sessionId)

    return { ok: true, sessionId, name, color }
  }

  hasPendingSession(sessionId: string): boolean {
    this.cleanupStalePending(this.now())
    return this.pendingSessions.has(sessionId)
  }

  releasePendingSession(sessionId: string): void {
    const pending = this.pendingSessions.get(sessionId)
    if (!pending) {
      return
    }

    this.pendingSessions.delete(sessionId)
    if (this.activeNames.get(pending.normalizedName) === sessionId) {
      this.activeNames.delete(pending.normalizedName)
    }
  }

  activateSession(sessionId: string): ActivationResult {
    const now = this.now()
    this.cleanupStalePending(now)
    this.cleanupRegrowth(now)
    this.cleanupExpiredNotices(now)

    const pending = this.pendingSessions.get(sessionId)
    if (!pending) {
      return { ok: false, reason: 'UNKNOWN_SESSION' }
    }

    const spawn = this.findPlayerSpawnTile(now)
    const player: PlayerState = {
      ...pending,
      ...spawn,
      score: 0,
      health: MAX_PLAYER_HEALTH,
      heading: 'up',
      notice: null,
    }

    this.pendingSessions.delete(sessionId)
    this.players.set(sessionId, player)
    this.occupiedTiles.set(coordKey(spawn.x, spawn.z), sessionId)
    this.updateStanding(player, true, now)
    if (!this.disableEnemies) {
      this.maintainEnemies(now)
    }

    const snapshot = this.getSnapshotFor(sessionId, now)
    if (!snapshot) {
      return { ok: false, reason: 'SNAPSHOT_UNAVAILABLE' }
    }

    return {
      ok: true,
      player: this.toVisiblePlayer(player),
      snapshot,
      leaderboard: snapshot.leaderboard,
    }
  }

  disconnect(sessionId: string): DisconnectResult {
    const now = this.now()
    this.cleanupRegrowth(now)
    this.cleanupExpiredNotices(now)

    if (this.pendingSessions.has(sessionId)) {
      this.releasePendingSession(sessionId)
      return {
        removed: true,
        changedTiles: [],
        changedPlayers: [],
        leaderboard: this.getLeaderboard(),
      }
    }

    const player = this.players.get(sessionId)
    if (!player) {
      return {
        removed: false,
        changedTiles: [],
        changedPlayers: [],
        leaderboard: this.getLeaderboard(),
      }
    }

    this.players.delete(sessionId)
    this.occupiedTiles.delete(coordKey(player.x, player.z))
    this.activeNames.delete(player.normalizedName)
    this.updateStanding(player, false, now)

    if (this.disableEnemies) {
      this.clearEnemies()
    } else if (this.players.size === 0) {
      this.clearEnemies()
    } else {
      this.maintainEnemies(now)
    }

    return {
      removed: true,
      changedTiles: [{ x: player.x, z: player.z }],
      changedPlayers: [sessionId],
      leaderboard: this.getLeaderboard(),
    }
  }

  applyMove(sessionId: string, direction: Direction): MoveResult {
    const now = this.now()
    const regrownTiles = this.cleanupRegrowth(now)
    this.cleanupExpiredNotices(now)
    const player = this.players.get(sessionId)
    if (!player) {
      return { ok: false, reason: 'NO_SESSION' }
    }

    const vector = DIRECTIONS[direction]
    const destination = {
      x: player.x + vector.x,
      z: player.z + vector.z,
    }

    const tile = this.getTileAt(destination.x, destination.z, now)
    if (tile.state !== 'dirt') {
      return { ok: false, reason: tile.state === 'regrowing' ? 'TILE_REGROWING' : 'TILE_EMPTY' }
    }

    if (this.isOccupied(destination.x, destination.z)) {
      return { ok: false, reason: 'TILE_OCCUPIED' }
    }

    const origin = { x: player.x, z: player.z }
    this.occupiedTiles.delete(coordKey(origin.x, origin.z))

    player.x = destination.x
    player.z = destination.z
    player.score += 1
    player.heading = direction

    this.occupiedTiles.set(coordKey(destination.x, destination.z), sessionId)
    this.updateStanding(player, true, now)
    this.regrowingTiles.set(coordKey(origin.x, origin.z), {
      ...origin,
      regrowAt: now + this.regrowDelay(),
    })

    return {
      ok: true,
      now,
      changedTiles: [...regrownTiles, origin, destination],
      changedPlayers: [sessionId],
      leaderboard: this.getLeaderboard(),
      player: this.toVisiblePlayer(player),
    }
  }

  rotatePlayer(sessionId: string, direction: TurnDirection): MoveResult {
    const now = this.now()
    this.cleanupExpiredNotices(now)
    const player = this.players.get(sessionId)
    if (!player) {
      return { ok: false, reason: 'NO_SESSION' }
    }

    player.heading = direction === 'left' ? rotateLeft(player.heading) : rotateRight(player.heading)

    return {
      ok: true,
      now,
      changedTiles: [],
      changedPlayers: [sessionId],
      leaderboard: this.getLeaderboard(),
      player: this.toVisiblePlayer(player),
    }
  }

  stepSimulation(now = this.now()): SimulationResult {
    this.cleanupExpiredNotices(now)
    const changedTiles = this.cleanupRegrowth(now)
    const changedPlayers = new Set<string>()

    if (this.players.size === 0) {
      return {
        changedTiles,
        changedPlayers: [],
        leaderboard: this.getLeaderboard(),
      }
    }

    if (this.disableEnemies) {
      return {
        changedTiles,
        changedPlayers: [...changedPlayers],
        leaderboard: this.getLeaderboard(),
      }
    }

    this.maintainEnemies(now)
    if (this.lastEnemyStepAt === 0) {
      this.lastEnemyStepAt = now - DUST_BUNNY_STEP_MS
    }

    if (now - this.lastEnemyStepAt < DUST_BUNNY_STEP_MS) {
      return {
        changedTiles,
        changedPlayers: [...changedPlayers],
        leaderboard: this.getLeaderboard(),
      }
    }

    this.lastEnemyStepAt = now
    for (const enemy of [...this.enemies.values()]) {
      const result = this.advanceEnemy(enemy, now)
      for (const tile of result.changedTiles) {
        changedTiles.push(tile)
      }
      for (const playerId of result.changedPlayers) {
        changedPlayers.add(playerId)
      }
    }

    this.maintainEnemies(now)

    return {
      changedTiles,
      changedPlayers: [...changedPlayers],
      leaderboard: this.getLeaderboard(),
    }
  }

  cleanupRegrowth(now = this.now()): Coord[] {
    const regrown: Coord[] = []
    for (const [key, tile] of this.regrowingTiles) {
      if (tile.regrowAt <= now) {
        this.regrowingTiles.delete(key)
        regrown.push({ x: tile.x, z: tile.z })
      }
    }
    return regrown
  }

  getSnapshotFor(sessionId: string, now = this.now()): WorldSnapshot | null {
    this.cleanupRegrowth(now)
    this.cleanupExpiredNotices(now)
    const player = this.players.get(sessionId)
    if (!player) {
      return null
    }

    return {
      selfSessionId: sessionId,
      now,
      viewRadius: VIEW_RADIUS_TILES,
      tiles: this.getVisibleTiles(player.x, player.z, now),
      players: this.getVisiblePlayers(player.x, player.z),
      enemies: this.getVisibleEnemies(player.x, player.z),
      leaderboard: this.getLeaderboard(),
      selfNotice: player.notice,
    }
  }

  buildDeltaFor(
    sessionId: string,
    changedTiles: Coord[],
    now = this.now(),
    leaderboard = this.getLeaderboard(),
  ):
    | {
        type: 'state_delta'
        now: number
        players: VisiblePlayer[]
        enemies: VisibleEnemy[]
        tiles: VisibleTile[]
        leaderboard: LeaderboardEntry[]
        selfNotice: CombatNotice | null
      }
    | null {
    this.cleanupRegrowth(now)
    this.cleanupExpiredNotices(now)
    const viewer = this.players.get(sessionId)
    if (!viewer) {
      return null
    }

    const tiles = changedTiles
      .filter((tile) => this.isWithinView(viewer, tile))
      .map((tile) => this.getTileAt(tile.x, tile.z, now))

    return {
      type: 'state_delta',
      now,
      players: this.getVisiblePlayers(viewer.x, viewer.z),
      enemies: this.getVisibleEnemies(viewer.x, viewer.z),
      tiles,
      leaderboard,
      selfNotice: viewer.notice,
    }
  }

  getTileState(x: number, z: number, now = this.now()): TileState {
    return this.getTileAt(x, z, now).state
  }

  getTileAt(x: number, z: number, now = this.now()): VisibleTile {
    const key = coordKey(x, z)
    const regrowingTile = this.regrowingTiles.get(key)
    if (regrowingTile && regrowingTile.regrowAt <= now) {
      this.regrowingTiles.delete(key)
    }

    if (!this.isProceduralDirt(x, z)) {
      return { x, z, state: 'void' }
    }

    const regrowing = this.regrowingTiles.get(key)
    if (regrowing) {
      return {
        x,
        z,
        state: 'regrowing',
        regrowAt: regrowing.regrowAt,
      }
    }

    return { x, z, state: 'dirt' }
  }

  getPlayer(sessionId: string): VisiblePlayer | null {
    const player = this.players.get(sessionId)
    return player ? this.toVisiblePlayer(player) : null
  }

  getEnemies(): VisibleEnemy[] {
    return [...this.enemies.values()].map((enemy) => this.toVisibleEnemy(enemy))
  }

  getLeaderboard(): LeaderboardEntry[] {
    return [...this.standings.values()]
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score
        }
        if (left.active !== right.active) {
          return left.active ? -1 : 1
        }
        if (right.updatedAt !== left.updatedAt) {
          return right.updatedAt - left.updatedAt
        }
        return left.name.localeCompare(right.name)
      })
      .map((standing) => ({
        sessionId: standing.sessionId ?? `standing:${standing.normalizedName}`,
        name: standing.name,
        score: standing.score,
        color: standing.color,
        active: standing.active,
      }))
  }

  restoreStandings(records: PersistedStanding[]): void {
    this.standings.clear()
    for (const record of records) {
      if (!isPersistedStanding(record)) {
        continue
      }

      this.standings.set(record.normalizedName, {
        ...record,
        active: false,
        sessionId: null,
      })
    }
  }

  serializeStandings(): PersistedStanding[] {
    return [...this.standings.values()].map(({ normalizedName, name, color, score, updatedAt }) => ({
      normalizedName,
      name,
      color,
      score,
      updatedAt,
    }))
  }

  private advanceEnemy(enemy: EnemyState, now: number): SimulationResult {
    const changedTiles: Coord[] = []
    const changedPlayers = new Set<string>()
    const nearest = this.findNearestPlayer(enemy)
    if (!nearest) {
      return { changedTiles, changedPlayers: [], leaderboard: this.getLeaderboard() }
    }

    const distance = manhattanDistance(enemy, nearest)
    const direction = this.chooseEnemyDirection(enemy, nearest, distance)
    if (distance === 1) {
      enemy.heading = direction
      const attacked = this.attackPlayer(enemy, nearest, now)
      for (const playerId of attacked.changedPlayers) {
        changedPlayers.add(playerId)
      }
      for (const tile of attacked.changedTiles) {
        changedTiles.push(tile)
      }
      return {
        changedTiles,
        changedPlayers: [...changedPlayers],
        leaderboard: this.getLeaderboard(),
      }
    }

    const step = DIRECTIONS[direction]
    const destination = { x: enemy.x + step.x, z: enemy.z + step.z }
    if (!this.canEnemyEnter(destination.x, destination.z, now)) {
      return { changedTiles, changedPlayers: [], leaderboard: this.getLeaderboard() }
    }

    this.reactivateTile(destination.x, destination.z)

    this.occupiedTiles.delete(coordKey(enemy.x, enemy.z))
    changedTiles.push({ x: enemy.x, z: enemy.z })

    enemy.x = destination.x
    enemy.z = destination.z
    enemy.heading = direction

    this.occupiedTiles.set(coordKey(enemy.x, enemy.z), enemy.enemyId)
    changedTiles.push({ x: enemy.x, z: enemy.z })
    return {
      changedTiles,
      changedPlayers: [...changedPlayers],
      leaderboard: this.getLeaderboard(),
    }
  }

  private attackPlayer(enemy: EnemyState, player: PlayerState, now: number): SimulationResult {
    const changedTiles: Coord[] = []
    const changedPlayers = new Set<string>()

    player.health = Math.max(0, player.health - 1)
    enemy.health -= 1
    player.notice = {
      message:
        enemy.health <= 0
          ? 'Dust bunny lunged. You auto-countered and flattened it.'
          : 'Dust bunny attack. Your roomba bumped back.',
      tone: enemy.health <= 0 ? 'success' : 'warning',
      expiresAt: now + NOTICE_TTL_MS,
    }
    changedPlayers.add(player.sessionId)

    if (enemy.health <= 0) {
      this.occupiedTiles.delete(coordKey(enemy.x, enemy.z))
      this.enemies.delete(enemy.enemyId)
      changedTiles.push({ x: enemy.x, z: enemy.z })
    }

    if (player.health <= 0) {
      const origin = { x: player.x, z: player.z }
      this.occupiedTiles.delete(coordKey(player.x, player.z))
      const spawn = this.findPlayerSpawnTile(now)
      player.x = spawn.x
      player.z = spawn.z
      player.health = MAX_PLAYER_HEALTH
      player.notice = {
        message: 'Dust bunnies overwhelmed you. Respawned with fresh brushes.',
        tone: 'warning',
        expiresAt: now + NOTICE_TTL_MS,
      }
      this.occupiedTiles.set(coordKey(player.x, player.z), player.sessionId)
      changedTiles.push(origin, spawn)
    }

    return {
      changedTiles,
      changedPlayers: [...changedPlayers],
      leaderboard: this.getLeaderboard(),
    }
  }

  private maintainEnemies(now: number): void {
    const target = this.desiredEnemyCount()
    while (this.enemies.size < target) {
      const spawn = this.findEnemySpawnTile(now)
      if (!spawn) {
        break
      }

      const enemyId = `dust-bunny:${crypto.randomUUID()}`
      const enemy: EnemyState = {
        enemyId,
        kind: 'dust-bunny',
        x: spawn.x,
        z: spawn.z,
        health: DUST_BUNNY_HEALTH,
        heading: 'down',
      }
      this.enemies.set(enemyId, enemy)
      this.occupiedTiles.set(coordKey(enemy.x, enemy.z), enemyId)
    }

    if (this.enemies.size > target) {
      const enemy = this.pickEnemyToDespawn()
      if (enemy) {
        this.occupiedTiles.delete(coordKey(enemy.x, enemy.z))
        this.enemies.delete(enemy.enemyId)
      }
    }
  }

  private clearEnemies(): void {
    for (const enemy of this.enemies.values()) {
      this.occupiedTiles.delete(coordKey(enemy.x, enemy.z))
    }
    this.enemies.clear()
  }

  private canEnemyEnter(x: number, z: number, now: number): boolean {
    return this.getTileState(x, z, now) !== 'void' && !this.isOccupied(x, z)
  }

  private isOccupied(x: number, z: number): boolean {
    return this.occupiedTiles.has(coordKey(x, z))
  }

  private getVisibleTiles(centerX: number, centerZ: number, now: number): VisibleTile[] {
    const tiles: VisibleTile[] = []
    for (let z = centerZ - VIEW_RADIUS_TILES; z <= centerZ + VIEW_RADIUS_TILES; z += 1) {
      for (let x = centerX - VIEW_RADIUS_TILES; x <= centerX + VIEW_RADIUS_TILES; x += 1) {
        tiles.push(this.getTileAt(x, z, now))
      }
    }
    return tiles
  }

  private getVisiblePlayers(centerX: number, centerZ: number): VisiblePlayer[] {
    return [...this.players.values()]
      .filter((player) => this.isWithinView({ x: centerX, z: centerZ }, player))
      .map((player) => this.toVisiblePlayer(player))
  }

  private getVisibleEnemies(centerX: number, centerZ: number): VisibleEnemy[] {
    return [...this.enemies.values()]
      .filter((enemy) => this.isWithinView({ x: centerX, z: centerZ }, enemy))
      .map((enemy) => this.toVisibleEnemy(enemy))
  }

  private isWithinView(origin: Coord, target: Coord): boolean {
    return Math.abs(origin.x - target.x) <= VIEW_RADIUS_TILES && Math.abs(origin.z - target.z) <= VIEW_RADIUS_TILES
  }

  private toVisiblePlayer(player: PlayerState): VisiblePlayer {
    return {
      sessionId: player.sessionId,
      name: player.name,
      score: player.score,
      health: player.health,
      color: player.color,
      x: player.x,
      z: player.z,
      heading: player.heading,
    }
  }

  private toVisibleEnemy(enemy: EnemyState): VisibleEnemy {
    return {
      enemyId: enemy.enemyId,
      kind: enemy.kind,
      x: enemy.x,
      z: enemy.z,
      health: enemy.health,
      heading: enemy.heading,
    }
  }

  private findPlayerSpawnTile(now: number): Coord {
    const initialCandidates = this.collectSpawnCandidates(now, CHUNK_SEARCH_RADIUS)
    if (initialCandidates.length > 0) {
      return this.pickBestSpawnCandidate(initialCandidates)
    }

    for (let radius = CHUNK_SEARCH_RADIUS + 1; radius <= CHUNK_SEARCH_RADIUS + 16; radius += 1) {
      const ringCandidates = this.collectSpawnCandidates(now, radius, true)
      if (ringCandidates.length > 0) {
        return this.pickBestSpawnCandidate(ringCandidates)
      }
    }

    return { x: 0, z: 0 }
  }

  private collectSpawnCandidates(now: number, radius: number, edgeOnly = false): SpawnCandidate[] {
    const candidates: SpawnCandidate[] = []

    for (let chunkZ = -radius; chunkZ <= radius; chunkZ += 1) {
      for (let chunkX = -radius; chunkX <= radius; chunkX += 1) {
        const onEdge = Math.abs(chunkX) === radius || Math.abs(chunkZ) === radius
        if (edgeOnly && !onEdge) {
          continue
        }

        const spawn = this.scanChunkForSpawn(chunkX, chunkZ, now)
        if (!spawn) {
          continue
        }

        const sector = getSpawnSector(spawn.x, spawn.z)
        candidates.push({
          spawn,
          crowd: this.countPlayersInChunk(chunkX, chunkZ),
          sectorCrowd: this.countPlayersInSector(sector),
          distance: Math.abs(chunkX) + Math.abs(chunkZ),
          nearestDistance: this.nearestPlayerDistance(spawn),
        })
      }
    }

    return candidates
  }

  private pickBestSpawnCandidate(candidates: SpawnCandidate[]): Coord {
    if (this.players.size === 0) {
      candidates.sort((left, right) => {
        if (left.crowd !== right.crowd) {
          return left.crowd - right.crowd
        }
        return left.distance - right.distance
      })
      return candidates[0]!.spawn
    }

    const desiredSeparation = Math.min(CHUNK_SIZE * 4, CHUNK_SIZE * 2 + Math.floor(this.players.size / 4) * (CHUNK_SIZE / 2))
    candidates.sort((left, right) => {
      if (left.sectorCrowd !== right.sectorCrowd) {
        return left.sectorCrowd - right.sectorCrowd
      }
      if (left.crowd !== right.crowd) {
        return left.crowd - right.crowd
      }

      const leftDistanceScore = Math.abs(left.nearestDistance - desiredSeparation)
      const rightDistanceScore = Math.abs(right.nearestDistance - desiredSeparation)
      if (leftDistanceScore !== rightDistanceScore) {
        return leftDistanceScore - rightDistanceScore
      }

      if (left.nearestDistance !== right.nearestDistance) {
        return right.nearestDistance - left.nearestDistance
      }

      return left.distance - right.distance
    })

    return candidates[0]!.spawn
  }

  private scanChunkForSpawn(chunkXValue: number, chunkZValue: number, now: number): Coord | null {
    const startX = chunkXValue * CHUNK_SIZE
    const startZ = chunkZValue * CHUNK_SIZE
    const offsets = buildScanOrder(CHUNK_SIZE)

    for (const { x: offsetX, z: offsetZ } of offsets) {
      const x = startX + offsetX
      const z = startZ + offsetZ
      if (this.getTileState(x, z, now) !== 'dirt') {
        continue
      }
      if (this.isOccupied(x, z)) {
        continue
      }
      if (!this.isSafePlayerSpawn(x, z)) {
        continue
      }
      return { x, z }
    }

    return null
  }

  private findEnemySpawnTile(now: number): Coord | null {
    const anchors = [...this.players.values()]
    if (anchors.length === 0) {
      return null
    }

    const candidates: Array<{
      coord: Coord
      nearestPlayerDistance: number
      nearestEnemyDistance: number
    }> = []

    for (const anchor of anchors) {
      const offsets = buildDustBunnyOffsets(DUST_BUNNY_SPAWN_RADIUS)
      for (const offset of offsets) {
        const x = anchor.x + offset.x
        const z = anchor.z + offset.z
        if (this.getTileState(x, z, now) !== 'dirt' || this.isOccupied(x, z)) {
          continue
        }

        const candidate = { x, z }
        const nearestPlayerDistance = this.nearestDistanceToPlayers(candidate)
        if (nearestPlayerDistance < DUST_BUNNY_MIN_PLAYER_SPAWN_DISTANCE) {
          continue
        }

        const nearestEnemyDistance = this.nearestDistanceToEnemies(candidate)
        if (nearestEnemyDistance < DUST_BUNNY_MIN_ENEMY_SPAWN_DISTANCE) {
          continue
        }

        candidates.push({
          coord: candidate,
          nearestPlayerDistance,
          nearestEnemyDistance,
        })
      }
    }

    if (candidates.length === 0) {
      return null
    }

    candidates.sort((left, right) => {
      if (left.nearestEnemyDistance !== right.nearestEnemyDistance) {
        return right.nearestEnemyDistance - left.nearestEnemyDistance
      }
      if (left.nearestPlayerDistance !== right.nearestPlayerDistance) {
        return right.nearestPlayerDistance - left.nearestPlayerDistance
      }
      if (left.coord.z !== right.coord.z) {
        return left.coord.z - right.coord.z
      }
      return left.coord.x - right.coord.x
    })

    return candidates[0]!.coord
  }

  private desiredEnemyCount(): number {
    if (this.players.size === 0) {
      return 0
    }

    return Math.min(MAX_DUST_BUNNIES, Math.max(4, this.players.size * 4))
  }

  private pickEnemyToDespawn(): EnemyState | null {
    let candidate: EnemyState | null = null
    let bestDistance = Number.NEGATIVE_INFINITY

    for (const enemy of this.enemies.values()) {
      const nearest = this.findNearestPlayer(enemy)
      const distance = nearest ? manhattanDistance(enemy, nearest) : Number.POSITIVE_INFINITY
      if (distance > bestDistance) {
        bestDistance = distance
        candidate = enemy
      }
    }

    return candidate
  }

  private isSafePlayerSpawn(x: number, z: number): boolean {
    for (const enemy of this.enemies.values()) {
      if (manhattanDistance(enemy, { x, z }) <= PLAYER_SPAWN_SAFE_RADIUS) {
        return false
      }
    }
    return true
  }

  private findNearestPlayer(from: Coord): PlayerState | null {
    let best: PlayerState | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const player of this.players.values()) {
      const distance = manhattanDistance(from, player)
      if (distance < bestDistance) {
        bestDistance = distance
        best = player
      }
    }
    return best
  }

  private chooseEnemyDirection(enemy: EnemyState, target: PlayerState, distance: number): Direction {
    if (distance > DUST_BUNNY_AGGRO_RADIUS) {
      return randomDirection(this.random)
    }

    const xDelta = target.x - enemy.x
    const zDelta = target.z - enemy.z

    if (Math.abs(xDelta) >= Math.abs(zDelta) && xDelta !== 0) {
      return xDelta > 0 ? 'right' : 'left'
    }
    if (zDelta !== 0) {
      return zDelta > 0 ? 'down' : 'up'
    }
    return enemy.heading
  }

  private countPlayersInChunk(chunkXValue: number, chunkZValue: number): number {
    let count = 0
    for (const player of this.players.values()) {
      if (chunkCoord(player.x) === chunkXValue && chunkCoord(player.z) === chunkZValue) {
        count += 1
      }
    }
    return count
  }

  private countPlayersInSector(sector: number): number {
    let count = 0
    for (const player of this.players.values()) {
      if (getSpawnSector(player.x, player.z) === sector) {
        count += 1
      }
    }
    return count
  }

  private nearestPlayerDistance(target: Coord): number {
    let bestDistance = Number.POSITIVE_INFINITY
    for (const player of this.players.values()) {
      bestDistance = Math.min(bestDistance, manhattanDistance(target, player))
    }
    return bestDistance
  }

  private nearestDistanceToPlayers(target: Coord): number {
    let bestDistance = Number.POSITIVE_INFINITY
    for (const player of this.players.values()) {
      bestDistance = Math.min(bestDistance, manhattanDistance(target, player))
    }
    return bestDistance
  }

  private nearestDistanceToEnemies(target: Coord): number {
    if (this.enemies.size === 0) {
      return Number.POSITIVE_INFINITY
    }

    let bestDistance = Number.POSITIVE_INFINITY
    for (const enemy of this.enemies.values()) {
      bestDistance = Math.min(bestDistance, manhattanDistance(target, enemy))
    }
    return bestDistance
  }

  private isProceduralDirt(x: number, z: number): boolean {
    return noiseAt(x, z) < DIRT_DENSITY
  }

  private regrowDelay(): number {
    const min = Math.min(this.regrowMinMs, this.regrowMaxMs)
    const max = Math.max(this.regrowMinMs, this.regrowMaxMs)
    return min + Math.floor(this.random() * (max - min + 1))
  }

  private reactivateTile(x: number, z: number): void {
    this.regrowingTiles.delete(coordKey(x, z))
  }

  private cleanupStalePending(now: number): void {
    for (const [sessionId, pending] of this.pendingSessions) {
      if (pending.createdAt + PENDING_TTL_MS > now) {
        continue
      }
      this.pendingSessions.delete(sessionId)
      if (this.activeNames.get(pending.normalizedName) === sessionId) {
        this.activeNames.delete(pending.normalizedName)
      }
    }
  }

  private cleanupExpiredNotices(now: number): void {
    for (const player of this.players.values()) {
      if (player.notice && player.notice.expiresAt <= now) {
        player.notice = null
      }
    }
  }

  private updateStanding(player: PlayerState, active: boolean, updatedAt: number): void {
    const previous = this.standings.get(player.normalizedName)
    this.standings.set(player.normalizedName, {
      normalizedName: player.normalizedName,
      name: player.name,
      color: player.color,
      score: Math.max(previous?.score ?? 0, player.score),
      updatedAt,
      active,
      sessionId: active ? player.sessionId : null,
    })
  }
}

function manhattanDistance(left: Coord, right: Coord): number {
  return Math.abs(left.x - right.x) + Math.abs(left.z - right.z)
}

function randomDirection(random: () => number): Direction {
  const index = Math.floor(random() * 4)
  return ['up', 'right', 'down', 'left'][index] as Direction
}

function getSpawnSector(x: number, z: number): number {
  if (x === 0 && z === 0) {
    return 0
  }

  const angle = Math.atan2(z, x)
  const normalized = angle < 0 ? angle + Math.PI * 2 : angle
  return Math.floor((normalized / (Math.PI * 2)) * 8) % 8
}

function noiseAt(x: number, z: number): number {
  let value = Math.imul(x, 374_761_393) ^ Math.imul(z, 668_265_263) ^ 0x9e3779b9
  value = Math.imul(value ^ (value >>> 13), 1_274_126_177)
  value ^= value >>> 16
  return (value >>> 0) / 4_294_967_295
}

function isPersistedStanding(value: unknown): value is PersistedStanding {
  if (!value || typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>
  return (
    typeof record.normalizedName === 'string' &&
    typeof record.name === 'string' &&
    typeof record.color === 'string' &&
    typeof record.score === 'number' &&
    Number.isFinite(record.score) &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt)
  )
}

function buildScanOrder(size: number): Coord[] {
  const center = (size - 1) / 2
  const coords: Coord[] = []
  for (let z = 0; z < size; z += 1) {
    for (let x = 0; x < size; x += 1) {
      coords.push({ x, z })
    }
  }

  return coords.sort((left, right) => {
    const leftDistance = Math.abs(left.x - center) + Math.abs(left.z - center)
    const rightDistance = Math.abs(right.x - center) + Math.abs(right.z - center)
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance
    }
    if (left.z !== right.z) {
      return left.z - right.z
    }
    return left.x - right.x
  })
}

function buildDustBunnyOffsets(radius: number): Coord[] {
  const offsets: Coord[] = []
  for (let z = -radius; z <= radius; z += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      if (x === 0 && z === 0) {
        continue
      }
      offsets.push({ x, z })
    }
  }

  return offsets.sort((left, right) => {
    const leftDistance = Math.abs(left.x) + Math.abs(left.z)
    const rightDistance = Math.abs(right.x) + Math.abs(right.z)
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance
    }
    if (left.z !== right.z) {
      return left.z - right.z
    }
    return left.x - right.x
  })
}
