import { GameWorld } from './game-world'
import { MAX_DUST_BUNNIES, type Coord } from '../shared/protocol'

function createWorld() {
  let now = 1_000
  const world = new GameWorld({
    now: () => now,
    random: () => 0,
  })

  return {
    world,
    now: () => now,
    advanceBy(delta: number) {
      now += delta
    },
  }
}

function joinAndActivate(world: GameWorld, name: string): string {
  const joined = world.createPendingSession(name)
  expect(joined.ok).toBe(true)
  if (!joined.ok) {
    throw new Error(joined.message)
  }

  const activated = world.activateSession(joined.sessionId)
  expect(activated.ok).toBe(true)
  return joined.sessionId
}

function findReachableNeighbor(world: GameWorld, origin: Coord): Coord {
  const internal = world as unknown as { occupiedTiles: Map<string, string> }
  const candidates: Coord[] = [
    { x: origin.x + 1, z: origin.z },
    { x: origin.x - 1, z: origin.z },
    { x: origin.x, z: origin.z + 1 },
    { x: origin.x, z: origin.z - 1 },
  ]

  const match = candidates.find(
    (candidate) =>
      world.getTileState(candidate.x, candidate.z) === 'dirt' && !internal.occupiedTiles.has(`${candidate.x},${candidate.z}`),
  )

  if (!match) {
    throw new Error('Expected at least one open dirty neighbor')
  }

  return match
}

describe('GameWorld', () => {
  it('validates names and releases them after disconnect', () => {
    const { world } = createWorld()

    expect(world.createPendingSession('')).toMatchObject({ ok: false, code: 'INVALID_NAME' })
    expect(world.createPendingSession('x'.repeat(21))).toMatchObject({ ok: false, code: 'INVALID_NAME' })
    expect(world.createPendingSession('Alice', 'blue')).toMatchObject({ ok: false, code: 'INVALID_COLOR' })

    const alice = world.createPendingSession('Alice')
    expect(alice.ok).toBe(true)
    expect(world.createPendingSession('alice')).toMatchObject({ ok: false, code: 'NAME_TAKEN' })

    if (!alice.ok) {
      throw new Error('join failed')
    }

    expect(world.activateSession(alice.sessionId).ok).toBe(true)
    expect(world.disconnect(alice.sessionId).removed).toBe(true)
    expect(world.createPendingSession('alice')).toMatchObject({ ok: true })
  })

  it('preserves a custom roomba color through activation', () => {
    const { world } = createWorld()
    const joined = world.createPendingSession('Alice', '#ff6600')
    expect(joined).toMatchObject({ ok: true, color: '#ff6600' })
    if (!joined.ok) {
      throw new Error('join failed')
    }

    const activated = world.activateSession(joined.sessionId)
    expect(activated.ok).toBe(true)
    expect(world.getPlayer(joined.sessionId)?.color).toBe('#ff6600')
  })

  it('keeps best session standings after disconnect and restores them after a world restart', () => {
    const { world } = createWorld()
    const sessionId = joinAndActivate(world, 'Alice')
    const player = world.getPlayer(sessionId)
    if (!player) {
      throw new Error('missing player')
    }

    const origin = { x: player.x, z: player.z }
    const destination = findReachableNeighbor(world, origin)
    const direction =
      destination.x > origin.x
        ? 'right'
        : destination.x < origin.x
          ? 'left'
          : destination.z > origin.z
            ? 'down'
            : 'up'

    expect(world.applyMove(sessionId, direction)).toMatchObject({ ok: true })
    expect(world.disconnect(sessionId).removed).toBe(true)
    expect(world.getLeaderboard()).toEqual([
      expect.objectContaining({
        name: 'Alice',
        score: 1,
        active: false,
      }),
    ])

    const restored = new GameWorld()
    restored.restoreStandings(world.serializeStandings())
    expect(restored.getLeaderboard()).toEqual([
      expect.objectContaining({
        name: 'Alice',
        score: 1,
        active: false,
      }),
    ])

    const rejoined = restored.createPendingSession('Alice')
    expect(rejoined.ok).toBe(true)
    if (!rejoined.ok) {
      throw new Error('rejoin failed')
    }

    expect(restored.activateSession(rejoined.sessionId)).toMatchObject({ ok: true })
    expect(restored.getPlayer(rejoined.sessionId)?.score).toBe(0)
    expect(restored.getLeaderboard()[0]).toEqual(
      expect.objectContaining({
        name: 'Alice',
        score: 1,
        active: true,
      }),
    )
  })

  it('spawns players on unique dirty tiles and includes visible dust bunnies', () => {
    const { world } = createWorld()
    const aliceId = joinAndActivate(world, 'Alice')
    const bobId = joinAndActivate(world, 'Bob')

    const alice = world.getPlayer(aliceId)
    const bob = world.getPlayer(bobId)
    expect(alice).not.toBeNull()
    expect(bob).not.toBeNull()

    if (!alice || !bob) {
      throw new Error('missing players')
    }

    expect(world.getTileState(alice.x, alice.z)).toBe('dirt')
    expect(world.getTileState(bob.x, bob.z)).toBe('dirt')
    expect(`${alice.x},${alice.z}`).not.toBe(`${bob.x},${bob.z}`)

    const snapshot = world.getSnapshotFor(aliceId)
    expect(snapshot?.enemies.length).toBeGreaterThan(0)
    expect(Math.abs(alice.x - bob.x) + Math.abs(alice.z - bob.z)).toBeGreaterThanOrEqual(48)
    expect(world.getEnemies().every((enemy) => Math.abs(enemy.x - bob.x) + Math.abs(enemy.z - bob.z) >= 5)).toBe(true)

    const nearbyToAlice = world
      .getEnemies()
      .filter((enemy) => Math.abs(enemy.x - alice.x) + Math.abs(enemy.z - alice.z) <= 6)
    expect(nearbyToAlice.length).toBeLessThanOrEqual(1)
  })

  it('scales dust bunny population with active players and despawns excess over time', () => {
    const clock = createWorld()
    const aliceId = joinAndActivate(clock.world, 'Alice')
    const bobId = joinAndActivate(clock.world, 'Bob')
    const caraId = joinAndActivate(clock.world, 'Cara')

    const crowdedCount = clock.world.getEnemies().length
    expect(crowdedCount).toBeGreaterThan(6)
    expect(crowdedCount).toBeLessThanOrEqual(MAX_DUST_BUNNIES)

    expect(clock.world.disconnect(bobId).removed).toBe(true)
    expect(clock.world.disconnect(caraId).removed).toBe(true)

    const afterDisconnect = clock.world.getEnemies().length
    expect(afterDisconnect).toBeLessThan(crowdedCount)
    expect(afterDisconnect).toBeGreaterThan(4)

    for (let index = 0; index < 8; index += 1) {
      clock.advanceBy(800)
      clock.world.stepSimulation(clock.now())
    }

    const settledCount = clock.world.getEnemies().length
    expect(settledCount).toBe(4)
    expect(clock.world.getPlayer(aliceId)).not.toBeNull()
  })

  it('scores on successful movement, blocks regrowing tiles, and regrows after 30 seconds', () => {
    const clock = createWorld()
    const sessionId = joinAndActivate(clock.world, 'Alice')
    const player = clock.world.getPlayer(sessionId)
    if (!player) {
      throw new Error('missing player')
    }

    const origin = { x: player.x, z: player.z }
    const destination = findReachableNeighbor(clock.world, origin)
    const direction =
      destination.x > origin.x
        ? 'right'
        : destination.x < origin.x
          ? 'left'
          : destination.z > origin.z
            ? 'down'
            : 'up'

    const moved = clock.world.applyMove(sessionId, direction)
    expect(moved.ok).toBe(true)
    if (!moved.ok) {
      throw new Error('move failed')
    }

    expect(moved.player.score).toBe(1)
    expect(clock.world.getTileState(origin.x, origin.z)).toBe('regrowing')

    const blocked = clock.world.applyMove(
      sessionId,
      direction === 'right'
        ? 'left'
        : direction === 'left'
          ? 'right'
          : direction === 'down'
            ? 'up'
            : 'down',
    )
    expect(blocked).toMatchObject({ ok: false, reason: 'TILE_REGROWING' })

    clock.advanceBy(29_999)
    expect(clock.world.getTileState(origin.x, origin.z)).toBe('regrowing')
    clock.advanceBy(1)
    clock.world.cleanupRegrowth()
    expect(clock.world.getTileState(origin.x, origin.z)).toBe('dirt')
  })

  it('lets dust bunnies move over regrowing tiles and make them dirty again', () => {
    const clock = createWorld()
    const aliceId = joinAndActivate(clock.world, 'Alice')
    const bobId = joinAndActivate(clock.world, 'Bob')
    const alice = clock.world.getPlayer(aliceId)
    if (!alice) {
      throw new Error('missing alice')
    }

    const origin = { x: alice.x, z: alice.z }
    const destination = findReachableNeighbor(clock.world, origin)
    const moveDirection =
      destination.x > origin.x
        ? 'right'
        : destination.x < origin.x
          ? 'left'
          : destination.z > origin.z
            ? 'down'
            : 'up'

    expect(clock.world.applyMove(aliceId, moveDirection)).toMatchObject({ ok: true })
    expect(clock.world.getTileState(origin.x, origin.z)).toBe('regrowing')

    const enemy = clock.world.getEnemies()[0]
    if (!enemy) {
      throw new Error('missing enemy')
    }

    forcePlayerPosition(clock.world, bobId, origin.x + 3, origin.z)
    forceEnemyPosition(clock.world, enemy.enemyId, origin.x - 1, origin.z)

    clock.advanceBy(800)
    clock.world.stepSimulation(clock.now())

    expect(clock.world.getTileState(origin.x, origin.z)).toBe('dirt')
  })

  it('rejects moving into occupied tiles and preserves procedural tile stability', () => {
    const { world } = createWorld()
    const aliceId = joinAndActivate(world, 'Alice')
    const bobId = joinAndActivate(world, 'Bob')

    const alice = world.getPlayer(aliceId)
    if (!alice) {
      throw new Error('missing alice')
    }

    const target = findReachableNeighbor(world, alice)
    forcePlayerPosition(world, bobId, target.x, target.z)

    const direction =
      target.x > alice.x ? 'right' : target.x < alice.x ? 'left' : target.z > alice.z ? 'down' : 'up'

    expect(world.applyMove(aliceId, direction)).toMatchObject({ ok: false, reason: 'TILE_OCCUPIED' })
    expect(world.getTileState(120, -95)).toBe(world.getTileState(120, -95))
  })

  it('rotates in place and then moves forward in the new heading', () => {
    const { world } = createWorld()
    const aliceId = joinAndActivate(world, 'Alice')
    const before = world.getPlayer(aliceId)
    if (!before) {
      throw new Error('missing alice')
    }

    const rotated = world.rotatePlayer(aliceId, 'right')
    expect(rotated.ok).toBe(true)

    const turned = world.getPlayer(aliceId)
    expect(turned?.x).toBe(before.x)
    expect(turned?.z).toBe(before.z)
    expect(turned?.heading).toBe('right')

    const moved = world.applyMove(aliceId, 'right')
    expect(moved.ok).toBe(true)
    if (!moved.ok) {
      throw new Error('move failed')
    }

    expect(moved.player.x).toBe(before.x + 1)
    expect(moved.player.z).toBe(before.z)
    expect(moved.player.heading).toBe('right')
  })

  it('lets dust bunnies attack, counterattack, and respawn a defeated player', () => {
    const clock = createWorld()
    const aliceId = joinAndActivate(clock.world, 'Alice')
    const player = clock.world.getPlayer(aliceId)
    const enemy = clock.world.getEnemies()[0]
    if (!player || !enemy) {
      throw new Error('missing combatants')
    }

    forceEnemyPosition(clock.world, enemy.enemyId, player.x + 1, player.z)
    clock.advanceBy(800)
    clock.world.stepSimulation(clock.now())

    const updated = clock.world.getPlayer(aliceId)
    const remainingEnemy = clock.world.getEnemies()[0]
    expect(updated?.health).toBe(2)
    expect(remainingEnemy?.health).toBe(1)
    expect(clock.world.getSnapshotFor(aliceId)?.selfNotice?.message).toContain('Dust bunny')

    clock.advanceBy(800)
    clock.world.stepSimulation(clock.now())
    expect(clock.world.getEnemies().length).toBeGreaterThanOrEqual(1)

    forceEnemyPosition(clock.world, clock.world.getEnemies()[0]!.enemyId, updated!.x + 1, updated!.z)
    forcePlayerHealth(clock.world, aliceId, 1)
    clock.advanceBy(800)
    clock.world.stepSimulation(clock.now())

    const respawned = clock.world.getPlayer(aliceId)
    expect(respawned?.health).toBe(3)
    expect(clock.world.getSnapshotFor(aliceId)?.selfNotice?.message).toContain('Respawned')
  })
})

function forcePlayerPosition(world: GameWorld, sessionId: string, x: number, z: number): void {
  const internal = world as unknown as {
    players: Map<string, { x: number; z: number }>
    occupiedTiles: Map<string, string>
  }

  const player = internal.players.get(sessionId)
  if (!player) {
    throw new Error('player not found')
  }

  internal.occupiedTiles.delete(`${player.x},${player.z}`)
  player.x = x
  player.z = z
  internal.occupiedTiles.set(`${x},${z}`, sessionId)
}

function forceEnemyPosition(world: GameWorld, enemyId: string, x: number, z: number): void {
  const internal = world as unknown as {
    enemies: Map<string, { x: number; z: number }>
    occupiedTiles: Map<string, string>
  }

  const enemy = internal.enemies.get(enemyId)
  if (!enemy) {
    throw new Error('enemy not found')
  }

  internal.occupiedTiles.delete(`${enemy.x},${enemy.z}`)
  enemy.x = x
  enemy.z = z
  internal.occupiedTiles.set(`${x},${z}`, enemyId)
}

function forcePlayerHealth(world: GameWorld, sessionId: string, health: number): void {
  const internal = world as unknown as {
    players: Map<string, { health: number }>
  }

  const player = internal.players.get(sessionId)
  if (!player) {
    throw new Error('player not found')
  }

  player.health = health
}
