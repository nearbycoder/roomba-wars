import { useState } from 'react'
import { BenchmarkHud } from './components/BenchmarkHud'
import { readBenchmarkConfig, useBenchmarkArena } from './benchmark/useBenchmarkArena'
import { WorldScene } from './game/WorldScene'

export default function BenchmarkApp() {
  const [config] = useState(() => readBenchmarkConfig())
  const { sceneNow, self, snapshot, speed, stats, setSpeed, setCameraFocus } = useBenchmarkArena(config)

  return (
    <main className="game-shell benchmark-shell">
      <div className="game-canvas">
        <WorldScene
          self={self}
          players={snapshot.players}
          enemies={snapshot.enemies}
          tiles={snapshot.tiles}
          now={sceneNow}
          cameraMode="free"
          spectatorView="benchmark"
          fillVoidTiles
          actorStyle="benchmark"
          onFreeCameraFocusChange={setCameraFocus}
        />
      </div>

      <BenchmarkHud config={config} snapshot={snapshot} speed={speed} stats={stats} onSpeedChange={setSpeed} />
    </main>
  )
}
