'use client';

import dynamic from 'next/dynamic';

const EarthScene = dynamic(
  () => import('@/components/earth-scene').then((module) => module.EarthScene),
  { ssr: false },
);

export default function Home() {
  return (
    <main className="simulator-shell">
      <EarthScene />
    </main>
  );
}
