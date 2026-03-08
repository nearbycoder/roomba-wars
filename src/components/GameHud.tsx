import type { GameState } from '../game/useRoombaWars'

interface ArenaCardProps {
  state: GameState
}

interface JoinCardProps {
  state: GameState
  onJoin: (name: string) => Promise<void>
  onLeave: () => void
}

interface LegendBubbleProps {
  isOpen: boolean
  onToggle: () => void
}

export function ArenaCard({ state }: ArenaCardProps) {
  const activeCount = state.leaderboard.filter((entry) => entry.active).length

  return (
    <section className="hud-card arena-card">
      <div className="arena-card-header">
        <div className="arena-card-copy">
          <span className="label">Arena status</span>
          <h2 className="arena-card-title">Live standings</h2>
        </div>
        <span className={`status-pill status-${state.status}`}>{state.statusLabel}</span>
      </div>
      <div className="stat-grid">
        <div className="stat-card">
          <span className="label">Score</span>
          <strong>{state.self?.score ?? 0}</strong>
        </div>
        <div className="stat-card">
          <span className="label">Health</span>
          <strong>{state.self ? `${state.self.health}/3` : '3/3'}</strong>
        </div>
        <div className="stat-card">
          <span className="label">Position</span>
          <strong className="stat-value-position">{state.self ? `${state.self.x}, ${state.self.z}` : 'origin'}</strong>
        </div>
      </div>
      {state.combatNotice ? <p className="combat-notice">{state.combatNotice}</p> : null}

      <div className="arena-divider" />

      <div className="arena-board-header">
        <div className="arena-board-copy">
          <span className="label">Standings</span>
          <p className="arena-board-note">Best single-session scores persist across restarts.</p>
        </div>
        <span className="active-chip">
          <span className="active-chip-dot" />
          {activeCount} active
        </span>
      </div>
      <ol className="leaderboard">
        {state.leaderboard.map((entry, index) => (
          <li
            key={entry.sessionId}
            className={[
              entry.sessionId === state.self?.sessionId ? 'is-self' : '',
              entry.active ? '' : 'is-inactive',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="leader-rank">{index + 1}</span>
            <span className="leader-identity">
              <span className="leader-color" style={{ backgroundColor: entry.color }} />
              <span className="leader-name">{entry.name}</span>
            </span>
            <strong className="leader-score">{entry.score}</strong>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function JoinCard({ state, onJoin, onLeave }: JoinCardProps) {
  const isBusy = state.status === 'joining' || state.status === 'connecting' || state.status === 'connected'

  return (
    <section className="hud-card join-card join-card-centered">
      <div className="card-row">
        <h2>Join Match</h2>
        <span>{state.name.length}/20</span>
      </div>
      <p className="join-copy">Join with a unique roomba name to spawn into the live world. Use `WASD` or arrow keys once connected.</p>
      <form
        className="join-form"
        onSubmit={(event) => {
          event.preventDefault()
          void onJoin(state.name)
        }}
      >
        <label className="label" htmlFor="name">
          Active roomba name
        </label>
        <input
          id="name"
          className="input"
          value={state.name}
          onChange={(event) => state.setName(event.target.value)}
          placeholder="DustBandit"
          maxLength={20}
          disabled={isBusy}
        />
        <div className="color-field">
          <div className="color-copy">
            <span className="label">Roomba color</span>
            <strong>{state.color.toUpperCase()}</strong>
          </div>
          <label className="color-picker" htmlFor="roomba-color">
            <span className="color-swatch" style={{ backgroundColor: state.color }} />
            <input
              id="roomba-color"
              className="color-input"
              type="color"
              value={state.color}
              onChange={(event) => state.setColor(event.target.value)}
              disabled={isBusy}
              aria-label="Choose roomba color"
            />
          </label>
        </div>
        <button className="primary-button" type="submit" disabled={!state.name.trim() || isBusy}>
          {state.status === 'joining' || state.status === 'connecting' ? 'Joining…' : 'Enter arena'}
        </button>
      </form>
      {state.self ? (
        <button className="secondary-button" type="button" onClick={onLeave} disabled={state.status !== 'connected'}>
          Disconnect
        </button>
      ) : null}
      {state.error ? <p className="message error">{state.error}</p> : null}
      {state.moveError ? <p className="message warning">{state.moveError}</p> : null}
    </section>
  )
}

export function LegendBubble({ isOpen, onToggle }: LegendBubbleProps) {
  return (
    <section className={`hud-card info-bubble ${isOpen ? 'is-open' : ''}`}>
      <button className="info-bubble-toggle" type="button" onClick={onToggle} aria-expanded={isOpen}>
        <span className="info-badge">i</span>
        <span className="info-bubble-copy">
          <strong>Info</strong>
          <small>{isOpen ? 'Hide controls' : 'Show controls'}</small>
        </span>
      </button>
      {isOpen ? (
        <div className="info-panel">
          <div className="card-row">
            <h2>Controls</h2>
            <span className="card-meta">Tap bubble</span>
          </div>
          <ul className="legend-list">
            <li>
              <span className="swatch dirt" />
              Dirt tiles are the only legal moves and score when you leave them.
            </li>
            <li>
              <span className="swatch regrowing" />
              Pale markers mean the tile is regrowing and blocked.
            </li>
            <li>
              <span className="swatch void" />
              Dark voids are permanent gaps in the field.
            </li>
            <li>
              <span className="swatch bunny" />
              Evil dust bunnies stalk dirty lanes, bite from adjacent tiles, and trigger auto-counter bumps.
            </li>
          </ul>
        </div>
      ) : null}
    </section>
  )
}
