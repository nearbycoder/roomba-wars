import type { BenchmarkConfig, BenchmarkSnapshot, BenchmarkStats } from '../benchmark/useBenchmarkArena'

interface BenchmarkHudProps {
  config: BenchmarkConfig
  snapshot: BenchmarkSnapshot
  speed: number
  stats: BenchmarkStats
  onSpeedChange: (value: number) => void
}

export function BenchmarkHud({ config, snapshot, speed, stats, onSpeedChange }: BenchmarkHudProps) {
  return (
    <header className="hud hud-top">
      <section className="hud-card brand-card">
        <p className="eyebrow">Roomba Wars</p>
        <h1>Benchmark Arena</h1>
        <p className="hud-copy">
          Local game-rule benchmark with dirt pickup, regrowth blocking, collision-safe bot movement, and optional dust bunny pressure.
        </p>
      </section>

      <section className="hud-card arena-card benchmark-panel">
        <div className="arena-card-header">
          <div className="arena-card-copy">
            <span className="label">Benchmark mode</span>
            <h2 className="arena-card-title">Renderer load</h2>
          </div>
          <span className="status-pill status-connected">live</span>
        </div>

        <div className="benchmark-grid">
          <div className="stat-card">
            <span className="label">Roombas</span>
            <strong>{config.botCount}</strong>
          </div>
          <div className="stat-card">
            <span className="label">FPS</span>
            <strong>{stats.currentFps}</strong>
          </div>
          <div className="stat-card">
            <span className="label">Average</span>
            <strong>{stats.averageFps}</strong>
          </div>
          <div className="stat-card">
            <span className="label">Min</span>
            <strong>{stats.minFps}</strong>
          </div>
          <div className="stat-card">
            <span className="label">Bunnies</span>
            <strong>{config.includeDustBunnies ? snapshot.enemies.length : 0}</strong>
          </div>
        </div>

        <div className="benchmark-control">
          <div className="benchmark-control-copy">
            <span className="label">Sim speed</span>
            <strong>{speed.toFixed(2)}x</strong>
          </div>
          <input
            className="benchmark-slider"
            type="range"
            min="0"
            max="4"
            step="0.25"
            value={speed}
            onChange={(event) => {
              onSpeedChange(Number.parseFloat(event.target.value))
            }}
            aria-label="Benchmark simulation speed"
          />
        </div>

        <div className="arena-divider" />

        <div className="arena-board-header">
          <div className="arena-board-copy">
            <span className="label">Scenario</span>
            <p className="arena-board-note">
              Drag to look. `WASD` move, `Ctrl/Q` lower, `Space/E` rise, mouse wheel dolly. Add `&square=1` to spread the crowd through one constrained square with 10-cell spacing and varied bot colors. The speed slider scales the local sim on top of dirt, regrow, collision, and optional dust bunny rules.
            </p>
          </div>
          <span className="active-chip">
            <span className="active-chip-dot" />
            {snapshot.leaderboard.length} active
          </span>
        </div>
      </section>
    </header>
  )
}
