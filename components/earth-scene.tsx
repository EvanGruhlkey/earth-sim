'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

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

function globePosition(point: Point, baseRadius: number, altitudeScale = 0) {
  const latitude = THREE.MathUtils.degToRad(point.latitude);
  const longitude = THREE.MathUtils.degToRad(point.longitude);
  const radius = baseRadius + Math.min(point.altitudeKm ?? 0, 40_000) * altitudeScale;
  const latitudeRadius = Math.cos(latitude) * radius;
  return new THREE.Vector3(
    Math.cos(longitude) * latitudeRadius,
    Math.sin(latitude) * radius,
    -Math.sin(longitude) * latitudeRadius,
  );
}

function createPointLayer(
  points: Point[],
  pixelRatio: number,
  options: { color: number; size: number; radius: number; altitudeScale?: number; opacity?: number },
) {
  const positions = new Float32Array(points.length * 3);
  points.forEach((point, index) => {
    globePosition(point, options.radius, options.altitudeScale).toArray(positions, index * 3);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: options.color,
      size: options.size * pixelRatio,
      sizeAttenuation: false,
      transparent: true,
      opacity: options.opacity ?? 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
}

function createWeatherLayer(points: WeatherPoint[], pixelRatio: number) {
  const positions = new Float32Array(points.length * 3);
  const colors = new Float32Array(points.length * 3);
  const cool = new THREE.Color(0x35c7d0);
  const warm = new THREE.Color(0xff9a3d);
  points.forEach((point, index) => {
    globePosition(point, 2.025).toArray(positions, index * 3);
    const temperatureMix = THREE.MathUtils.clamp((point.temperature + 30) / 70, 0, 1);
    cool.clone().lerp(warm, temperatureMix).multiplyScalar(0.65 + point.cloudCover / 285)
      .toArray(colors, index * 3);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      vertexColors: true,
      size: 4.4 * pixelRatio,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
}

function disposeLayers(group: THREE.Group) {
  group.traverse((object) => {
    if (object instanceof THREE.Points) {
      object.geometry.dispose();
      (Array.isArray(object.material) ? object.material : [object.material])
        .forEach((material) => material.dispose());
    }
  });
  group.clear();
}

function createEarthSurface() {
  return new THREE.Mesh(
    new THREE.SphereGeometry(1.985, 128, 96),
    new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          vViewPosition = viewPosition.xyz;
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        void main() {
          vec3 normal = normalize(vNormal);
          vec3 viewDirection = normalize(-vViewPosition);
          float fresnel = pow(1.0 - max(dot(normal, viewDirection), 0.0), 2.6);
          float longitude = atan(normal.z, normal.x) / 6.2831853 + 0.5;
          float latitude = asin(clamp(normal.y, -1.0, 1.0)) / 3.1415926 + 0.5;
          float longitudeLine = 1.0 - smoothstep(0.0, 0.035, abs(fract(longitude * 24.0) - 0.5));
          float latitudeLine = 1.0 - smoothstep(0.0, 0.035, abs(fract(latitude * 12.0) - 0.5));
          float grid = max(longitudeLine, latitudeLine) * 0.14;
          vec3 base = vec3(0.012, 0.055, 0.072);
          vec3 gridColor = vec3(0.08, 0.38, 0.42) * grid;
          vec3 atmosphere = vec3(0.08, 0.55, 0.62) * fresnel * 0.5;
          gl_FragColor = vec4(base + gridColor + atmosphere, 1.0);
        }
      `,
    }),
  );
}

function createAtmosphere() {
  return new THREE.Mesh(
    new THREE.SphereGeometry(2.07, 96, 64),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        void main() {
          float rim = pow(0.72 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.0);
          gl_FragColor = vec4(0.08, 0.65, 0.76, rim * 0.34);
        }
      `,
    }),
  );
}

export function EarthScene() {
  const hostRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<THREE.Group | null>(null);
  const pixelRatioRef = useRef(1);
  const [status, setStatus] = useState<SceneStatus>('loading');
  const [counts, setCounts] = useState<Counts>({ weather: 0, aircraft: 0, satellites: 0 });
  const [updatedAt, setUpdatedAt] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch('/api/live');
        if (!response.ok) throw new Error(`Live data returned ${response.status}`);
        const payload = (await response.json()) as LivePayload;
        if (cancelled || !layersRef.current) return;
        const layers = layersRef.current;
        disposeLayers(layers);
        layers.add(
          createWeatherLayer(payload.weather.data, pixelRatioRef.current),
          createPointLayer(payload.aircraft.data, pixelRatioRef.current, {
            color: 0xffbd66, size: 1.35, radius: 2.038, altitudeScale: 0.000002,
          }),
          createPointLayer(payload.satellites.data, pixelRatioRef.current, {
            color: 0xd9f7ff, size: 1.55, radius: 2.08, altitudeScale: 0.000035, opacity: 0.78,
          }),
        );
        setCounts({
          weather: payload.weather.data.length,
          aircraft: payload.aircraft.data.length,
          satellites: payload.satellites.data.length,
        });
        setUpdatedAt(payload.updatedAt);
        setStatus(payload.weather.error || payload.aircraft.error || payload.satellites.error ? 'partial' : 'ready');
      } catch {
        if (!cancelled) setStatus('partial');
      }
    };
    void load();
    const interval = window.setInterval(load, 60_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' });
    if (!context) { queueMicrotask(() => setStatus('unsupported')); return; }
    host.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: false });
    const pixelRatio = Math.min(window.devicePixelRatio, 1.6);
    pixelRatioRef.current = pixelRatio;
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x03080b, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0.15, 6.7);
    const globe = new THREE.Group();
    globe.rotation.set(-0.12, -0.58, -0.18);
    globe.add(createEarthSurface(), createAtmosphere());
    const layers = new THREE.Group();
    layersRef.current = layers;
    globe.add(layers);
    scene.add(globe);

    let pointerDown = false;
    let previousX = 0;
    let previousY = 0;
    let velocityX = 0;
    let velocityY = 0;
    let cameraDistance = 6.7;
    let animationFrame = 0;
    const resize = () => {
      renderer.setSize(host.clientWidth, host.clientHeight, false);
      camera.aspect = host.clientWidth / Math.max(host.clientHeight, 1);
      camera.updateProjectionMatrix();
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerDown = true; previousX = event.clientX; previousY = event.clientY;
      canvas.setPointerCapture(event.pointerId); canvas.classList.add('is-grabbing');
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!pointerDown) return;
      velocityX = (event.clientX - previousX) * 0.0038;
      velocityY = (event.clientY - previousY) * 0.0038;
      globe.rotation.y += velocityX;
      globe.rotation.x = THREE.MathUtils.clamp(globe.rotation.x + velocityY, -1.25, 1.25);
      previousX = event.clientX; previousY = event.clientY;
    };
    const onPointerUp = (event: PointerEvent) => {
      pointerDown = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      canvas.classList.remove('is-grabbing');
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      cameraDistance = THREE.MathUtils.clamp(cameraDistance + event.deltaY * 0.0025, 4.65, 9.4);
    };
    let lastFrame = performance.now();
    const render = (now: number) => {
      const delta = Math.min((now - lastFrame) / 1000, 0.05); lastFrame = now;
      if (!pointerDown) {
        globe.rotation.y += 0.022 * delta + velocityX;
        globe.rotation.x = THREE.MathUtils.clamp(globe.rotation.x + velocityY, -1.25, 1.25);
        velocityX *= 0.93; velocityY *= 0.93;
      }
      camera.position.z = THREE.MathUtils.lerp(camera.position.z, cameraDistance, 0.09);
      renderer.render(scene, camera);
      animationFrame = requestAnimationFrame(render);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    resize(); animationFrame = requestAnimationFrame(render);
    return () => {
      layersRef.current = null;
      cancelAnimationFrame(animationFrame); observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
          object.geometry.dispose();
          (Array.isArray(object.material) ? object.material : [object.material]).forEach((material) => material.dispose());
        }
      });
      renderer.dispose(); canvas.remove();
    };
  }, []);

  const total = counts.weather + counts.aircraft + counts.satellites;
  return (
    <div ref={hostRef} className="earth-scene" aria-label="Interactive live Earth data globe">
      <div className="earth-scene__readout" aria-live="polite">
        <span className={`status-dot status-dot--${status}`} />
        {status === 'loading' && 'Loading live sources'}
        {status === 'unsupported' && 'WebGL 2 is required'}
        {(status === 'ready' || status === 'partial') && (
          <>{total.toLocaleString()} live points · {status === 'partial' ? 'some sources unavailable' : 'all sources online'}</>
        )}
      </div>
      <div className="earth-scene__sources">
        <span>Weather {counts.weather.toLocaleString()} · Open-Meteo</span>
        <span>Aircraft {counts.aircraft.toLocaleString()} · OpenSky</span>
        <span>Satellites {counts.satellites.toLocaleString()} · CelesTrak</span>
        {updatedAt && <time dateTime={updatedAt}>Updated {new Date(updatedAt).toLocaleTimeString()}</time>}
      </div>
      <p className="earth-scene__hint">Drag to orbit · Scroll to zoom</p>
    </div>
  );
}
