import { EarthScene } from '@/components/earth-scene';

export default function Home() {
  return (
    <main className="simulator-shell">
      <EarthScene />

      <header className="simulator-header">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <p className="eyebrow">Orbital systems monitor</p>
          <h1>Earth / Real time</h1>
        </div>
        <div className="live-badge">
          <span className="live-badge__pulse" />
          Live simulation
        </div>
      </header>

    </main>
  );
}
