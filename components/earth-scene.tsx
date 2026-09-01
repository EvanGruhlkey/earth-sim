'use client';

import { Cloud, Plane, Satellite } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
  type OMMJsonObject,
} from 'satellite.js';
import {
  CallbackPositionProperty,
  Cartesian3,
  Color,
  CustomDataSource,
  GeographicTilingScheme,
  HeadingPitchRoll,
  ImageryLayer,
  SingleTileImageryProvider,
  UrlTemplateImageryProvider,
  VelocityOrientationProperty,
  Viewer,
} from 'cesium';

type Point = {
  latitude: number;
  longitude: number;
  altitudeKm?: number;
  heading?: number;
  velocity?: number;
  verticalRate?: number;
  observedAt?: number;
};
type WeatherPoint = Point & { temperature: number; cloudCover: number; windSpeed: number };
type OrbitalElement = OMMJsonObject & { OBJECT_NAME: string; NORAD_CAT_ID: string | number };
type SourceResult<T> = { data: T; error: string | null };
type LivePayload = {
  updatedAt: string;
  weather: SourceResult<WeatherPoint[]>;
  aircraft: SourceResult<Point[]>;
  satellites: SourceResult<OrbitalElement[]>;
};
type Counts = { weather: number; aircraft: number; satellites: number };
type SceneStatus = 'loading' | 'ready' | 'partial' | 'unsupported';
type ToggleableLayer = { show: boolean };

function sample<T>(items: T[], maximum: number) {
  const stride = Math.max(1, Math.ceil(items.length / maximum));
  return items.filter((_, index) => index % stride === 0);
}

function recentGibsDate() {
  return new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
}

function createObservationLayer(viewer: Viewer) {
  const date = recentGibsDate();
  const provider = new UrlTemplateImageryProvider({
    url: `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${date}/250m/{z}/{y}/{x}.jpg`,
    credit: 'NASA Global Imagery Browse Services (GIBS)',
    tilingScheme: new GeographicTilingScheme(),
    maximumLevel: 6,
    tileWidth: 512,
    tileHeight: 512,
  });
  const layer = viewer.imageryLayers.addImageryProvider(provider);
  layer.alpha = 0.82;
  layer.brightness = 0.86;
  layer.contrast = 1.08;
  return layer;
}

function predictedAircraftPosition(point: Point, date: Date) {
  const elapsed = Math.min(Math.max(date.getTime() / 1000 - (point.observedAt ?? 0), 0), 15 * 60);
  const distance = (point.velocity ?? 0) * elapsed;
  const bearing = ((point.heading ?? 0) * Math.PI) / 180;
  const latitude = (point.latitude * Math.PI) / 180;
  const longitude = (point.longitude * Math.PI) / 180;
  const angularDistance = distance / 6_371_000;
  const nextLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance) +
    Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const nextLongitude = longitude + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(nextLatitude),
  );
  const altitude = Math.max((point.altitudeKm ?? 0) * 1_000 + (point.verticalRate ?? 0) * elapsed, 100);
  return Cartesian3.fromRadians(nextLongitude, nextLatitude, altitude);
}

function createAircraftLayer(viewer: Viewer, points: Point[]) {
  const dataSource = new CustomDataSource('aircraft');
  sample(points, 36).forEach((point) => {
    const position = new CallbackPositionProperty(() => predictedAircraftPosition(point, new Date()), false);
    dataSource.entities.add({
      position,
      orientation: new VelocityOrientationProperty(position),
      model: {
        uri: '/aircraft.glb',
        minimumPixelSize: 25,
        maximumScale: 90_000,
        scale: 1.25,
      },
    });
  });
  void viewer.dataSources.add(dataSource);
  return dataSource;
}

function createSatelliteLayer(viewer: Viewer, elements: OrbitalElement[]) {
  const dataSource = new CustomDataSource('satellites');
  sample(elements, 24).forEach((element) => {
    const record = json2satrec(element);
    const position = new CallbackPositionProperty(() => {
      const date = new Date();
      const state = propagate(record, date);
      if (!state) return Cartesian3.ZERO;
      const geodetic = eciToGeodetic(state.position, gstime(date));
      return Cartesian3.fromRadians(geodetic.longitude, geodetic.latitude, geodetic.height * 1_000);
    }, false);
    dataSource.entities.add({
      name: element.OBJECT_NAME,
      position,
      orientation: new VelocityOrientationProperty(position),
      model: {
        uri: '/satellite.glb',
        minimumPixelSize: 23,
        maximumScale: 140_000,
        scale: 1_200,
      },
    });
  });
  void viewer.dataSources.add(dataSource);
  return dataSource;
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
  const weatherLayerRef = useRef<ToggleableLayer | null>(null);
  const trackingLayersRef = useRef<ToggleableLayer[]>([]);
  const visibleLayersRef = useRef([true, true, true]);
  const [status, setStatus] = useState<SceneStatus>('loading');
  const [counts, setCounts] = useState<Counts>({ weather: 0, aircraft: 0, satellites: 0 });
  const [updatedAt, setUpdatedAt] = useState<string>();
  const [visibleLayers, setVisibleLayers] = useState([true, true, true]);

  useEffect(() => {
    visibleLayersRef.current = visibleLayers;
    if (weatherLayerRef.current) weatherLayerRef.current.show = visibleLayers[0];
    trackingLayersRef.current.forEach((layer, index) => { layer.show = visibleLayers[index + 1]; });
    viewerRef.current?.scene.requestRender();
  }, [visibleLayers]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let viewer: Viewer;
    try {
      viewer = new Viewer(host, {
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
    } catch {
      queueMicrotask(() => setStatus('unsupported'));
      return;
    }
    viewerRef.current = viewer;
    viewer.scene.backgroundColor = Color.BLACK;
    viewer.scene.globe.baseColor = Color.fromCssColorString('#06101c');
    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.showGroundAtmosphere = true;
    viewer.scene.highDynamicRange = true;
    if (viewer.scene.skyAtmosphere) {
      viewer.scene.skyAtmosphere.hueShift = -0.03;
      viewer.scene.skyAtmosphere.saturationShift = 0.08;
      viewer.scene.skyAtmosphere.brightnessShift = -0.1;
    }
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 6_500_000;
    viewer.scene.screenSpaceCameraController.maximumZoomDistance = 45_000_000;
    setInitialView(viewer);

    void SingleTileImageryProvider.fromUrl('/earth-diffuse.jpg', {
      credit: 'Earth imagery: three.js project assets',
    }).then((provider) => {
      if (!cancelled && !viewer.isDestroyed()) {
        viewer.imageryLayers.add(new ImageryLayer(provider));
        const observationLayer = createObservationLayer(viewer);
        observationLayer.show = visibleLayersRef.current[0];
        weatherLayerRef.current = observationLayer;
      }
    });

    const load = async () => {
      try {
        const response = await fetch('/api/live');
        if (!response.ok) throw new Error(`Live data returned ${response.status}`);
        const payload = (await response.json()) as LivePayload;
        if (cancelled || viewer.isDestroyed()) return;

        trackingLayersRef.current.forEach((layer) => viewer.dataSources.remove(layer as CustomDataSource, true));
        const layers = [
          createSatelliteLayer(viewer, payload.satellites.data),
          createAircraftLayer(viewer, payload.aircraft.data),
        ];
        layers.forEach((layer, index) => { layer.show = visibleLayersRef.current[index + 1]; });
        trackingLayersRef.current = layers;
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
      weatherLayerRef.current = null;
      trackingLayersRef.current = [];
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
