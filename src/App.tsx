import { useState } from 'react'
import { ArenaCard, JoinCard, LegendBubble } from './components/GameHud'
import { WorldScene } from './game/WorldScene'
import { useRoombaWars } from './game/useRoombaWars'
import { useFpsCounter } from './hooks/useFpsCounter'

function App() {
  const { state, joinGame, leaveGame } = useRoombaWars()
  const fps = useFpsCounter()
  const [isInfoOpen, setIsInfoOpen] = useState(false)

  return (
    <main className="game-shell">
      <div className="game-canvas">
        <WorldScene self={state.self} players={state.players} enemies={state.enemies} tiles={state.tiles} now={state.now} />
      </div>

      <header className="hud hud-top">
        <section className="hud-card brand-card">
          <p className="eyebrow">Roomba Wars</p>
          <h1>Infinite Dirt Arena</h1>
          <p className="hud-copy">
            Vacuum more live dirt than the rest. Every cleaned tile locks out until it regrows 30 to 60 seconds later.
          </p>
        </section>

        <ArenaCard state={state} />
      </header>

      <div className="hud hud-fps">
        <section className="hud-card fps-card">
          <span className="label">FPS</span>
          <strong>{fps}</strong>
        </section>
      </div>

      <div className="hud hud-left-info">
        <LegendBubble isOpen={isInfoOpen} onToggle={() => setIsInfoOpen((current) => !current)} />
      </div>

      {!state.self ? (
        <div className="center-overlay">
          <JoinCard state={state} onJoin={joinGame} onLeave={leaveGame} />
        </div>
      ) : null}
    </main>
  )
}

export default App
