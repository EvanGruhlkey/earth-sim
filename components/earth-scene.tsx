'use client';

import { Cloud, Plane, Satellite } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  BillboardCollection,
  Cartesian3,
  Color,
  HeadingPitchRoll,
  ImageryLayer,
  PointPrimitiveCollection,
  SingleTileImageryProvider,
  Transforms,
  Viewer,
} from 'cesium';

type Point = { latitude: number; longitude: number; altitudeKm?: number };
type WeatherPoint = Point & { temperature: number; cloudCover: number; windSpeed: number };
type SourceResult<T> = { data: T; error: string | null };
type LivePayload = {
  updatedAt: string;
  weather: SourceResult<WeatherPoint[]>;
  aircraft: SourceResult<Point[]>;
  satellites: SourceResult<Point[]>;
};
type Counts = { weather: number; aircraft: number; satellites: number };
type SceneStatus = 'loading' | 'ready' | 'partial' | 'unsupported';
type ToggleableLayer = { show: boolean };

const AIRCRAFT_ICON = `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <path fill="white" d="M35 4l5 22 18 9v6l-18-4-2 17 7 5v3l-13-3-13 3v-3l7-5-2-17-18 4v-6l18-9 5-22z"/>
  </svg>
`)}`;

const SATELLITE_ICON = `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 48">
    <g stroke="#dce9f5" stroke-width="3"><path fill="#3478d4" d="M1 8h22v32H1zM49 8h22v32H49z"/><path fill="#dce9f5" d="M27 12h18v24H27z"/><path d="M23 24h4m18 0h4"/></g>
  </svg>
`)}`;

function sample<T>(items: T[], maximum: number) {
  const stride = Math.max(1, Math.ceil(items.length / maximum));
  return items.filter((_, index) => index % stride === 0);
}

function weatherColor(point: WeatherPoint) {
  const mix = Math.min(Math.max((point.temperature + 30) / 70, 0), 1);
  return Color.lerp(Color.fromCssColorString('#35c7d0'), Color.fromCssColorString('#ff9a3d'), mix, new Color())
    .withAlpha(0.5);
}

function createWeatherLayer(viewer: Viewer, points: WeatherPoint[]) {
  const collection = new PointPrimitiveCollection();
  points.forEach((point) => {
    collection.add({
      position: Cartesian3.fromDegrees(point.longitude, point.latitude, 18_000),
      color: weatherColor(point),
      outlineColor: weatherColor(point).withAlpha(0.18),
      outlineWidth: 7,
      pixelSize: 9 + point.cloudCover * 0.07 + point.windSpeed * 0.04,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
  });
  return viewer.scene.primitives.add(collection);
}

function createBillboardLayer(
  viewer: Viewer,
  points: Point[],
  maximum: number,
  image: string,
  size: { width: number; height: number },
  altitudeScale: number,
) {
  const collection = new BillboardCollection({ scene: viewer.scene });
  sample(points, maximum).forEach((point) => {
    collection.add({
      position: Cartesian3.fromDegrees(
        point.longitude,
        point.latitude,
        Math.max(point.altitudeKm ?? 0, 1) * altitudeScale,
      ),
      image,
      width: size.width,
      height: size.height,
      rotation: ((point.longitude * 3 + point.latitude) * Math.PI) / 180,
      color: Color.WHITE.withAlpha(0.92),
      disableDepthTestDistance: 3_000_000,
    });
  });
  return viewer.scene.primitives.add(collection);
}

function setInitialView(viewer: Viewer) {
  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(-78, 18, 13_800_000),
    orientation: new HeadingPitchRoll(0, -Math.PI / 2, 0),
  });
}

export function EarthScene() {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const layerObjectsRef = useRef<ToggleableLayer[]>([]);
  const visibleLayersRef = useRef([true, true, true]);
  const [status, setStatus] = useState<SceneStatus>('loading');
  const [counts, setCounts] = useState<Counts>({ weather: 0, aircraft: 0, satellites: 0 });
  const [updatedAt, setUpdatedAt] = useState<string>();
  const [visibleLayers, setVisibleLayers] = useState([true, true, true]);

  useEffect(() => {
    visibleLayersRef.current = visibleLayers;
    layerObjectsRef.current.forEach((layer, index) => { layer.show = visibleLayers[index]; });
    viewerRef.current?.scene.requestRender();
  }, [visibleLayers]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !Viewer.isSupported()) {
      queueMicrotask(() => setStatus('unsupported'));
      return;
    }

    let cancelled = false;
    const viewer = new Viewer(host, {
      animation: false,
      baseLayer: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      scene3DOnly: true,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      vrButton: false,
    });
    viewerRef.current = viewer;
    viewer.scene.backgroundColor = Color.BLACK;
    viewer.scene.globe.baseColor = Color.fromCssColorString('#06101c');
    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.showGroundAtmosphere = true;
    viewer.scene.highDynamicRange = true;
    viewer.scene.skyAtmosphere.hueShift = -0.03;
    viewer.scene.skyAtmosphere.saturationShift = 0.08;
    viewer.scene.skyAtmosphere.brightnessShift = -0.1;
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 6_500_000;
    viewer.scene.screenSpaceCameraController.maximumZoomDistance = 45_000_000;
    setInitialView(viewer);

    void SingleTileImageryProvider.fromUrl('/earth-diffuse.jpg', {
      credit: 'Earth imagery: three.js project assets',
    }).then((provider) => {
      if (!cancelled && !viewer.isDestroyed()) {
        viewer.imageryLayers.add(new ImageryLayer(provider));
      }
    });

    const load = async () => {
      try {
        const response = await fetch('/api/live');
        if (!response.ok) throw new Error(`Live data returned ${response.status}`);
        const payload = (await response.json()) as LivePayload;
        if (cancelled || viewer.isDestroyed()) return;

        layerObjectsRef.current.forEach((layer) => viewer.scene.primitives.remove(layer as never));
        const layers = [
          createWeatherLayer(viewer, payload.weather.data),
          createBillboardLayer(viewer, payload.satellites.data, 72, SATELLITE_ICON, { width: 34, height: 23 }, 1_000),
          createBillboardLayer(viewer, payload.aircraft.data, 180, AIRCRAFT_ICON, { width: 19, height: 19 }, 1_000),
        ];
        layers.forEach((layer, index) => { layer.show = visibleLayersRef.current[index]; });
        layerObjectsRef.current = layers;
        setCounts({
          weather: payload.weather.data.length,
          aircraft: payload.aircraft.data.length,
          satellites: payload.satellites.data.length,
        });
        setUpdatedAt(payload.updatedAt);
        setStatus(payload.weather.error || payload.aircraft.error || payload.satellites.error ? 'partial' : 'ready');
        viewer.scene.requestRender();
      } catch {
        if (!cancelled) setStatus('partial');
      }
    };
    void load();
    const interval = window.setInterval(load, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      layerObjectsRef.current = [];
      viewerRef.current = null;
      if (!viewer.isDestroyed()) viewer.destroy();
    };
  }, []);

  const total = counts.weather + counts.aircraft + counts.satellites;
  return (
    <div className="earth-scene-shell">
      <div ref={hostRef} className="earth-scene" aria-label="Interactive live Earth data globe" />
      <h1 className="earth-scene__title">Earth</h1>
      <div className="earth-scene__live" aria-live="polite">
        <span className={`status-dot status-dot--${status}`} />
        {status === 'loading' && 'Loading'}
        {status === 'unsupported' && 'WebGL 2 is required'}
        {(status === 'ready' || status === 'partial') && <>Live</>}
        {updatedAt && (
          <time dateTime={updatedAt}>
            {new Date(updatedAt).toLocaleTimeString([], {
              hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
            })} UTC
          </time>
        )}
      </div>
      <div className="layer-panel">
        {[
          { label: 'Weather', icon: Cloud, count: counts.weather },
          { label: 'Satellites', icon: Satellite, count: counts.satellites },
          { label: 'Aircraft', icon: Plane, count: counts.aircraft },
        ].map(({ label, icon: Icon, count }, index) => (
          <button
            key={label}
            type="button"
            className="layer-control"
            aria-pressed={visibleLayers[index]}
            onClick={() => setVisibleLayers((current) => current.map((value, item) => item === index ? !value : value))}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
            <small>{count.toLocaleString()}</small>
            <span className={`layer-toggle${visibleLayers[index] ? ' is-on' : ''}`} aria-hidden="true" />
          </button>
        ))}
      </div>
      <span className="sr-only">{total.toLocaleString()} live data points</span>
    </div>
  );
}
