'use client';

import { useEffect, useRef, useState } from 'react';
import { Cloud, Plane, Satellite } from 'lucide-react';
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

function surfaceTransform(point: Point, radius: number, altitudeScale = 0) {
  const position = globePosition(point, radius, altitudeScale);
  const normal = position.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
  return { position, quaternion };
}

function createWeatherLayer(points: WeatherPoint[]) {
  const geometry = new THREE.IcosahedronGeometry(1, 2);
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.38,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, points.length);
  const matrix = new THREE.Matrix4();
  const cool = new THREE.Color(0x35c7d0);
  const warm = new THREE.Color(0xff9a3d);
  points.forEach((point, index) => {
    const { position, quaternion } = surfaceTransform(point, 2.025);
    const spread = 0.035 + point.cloudCover * 0.00065 + point.windSpeed * 0.00035;
    matrix.compose(position, quaternion, new THREE.Vector3(spread * 1.35, 0.008 + spread * 0.12, spread));
    mesh.setMatrixAt(index, matrix);
    const temperatureMix = THREE.MathUtils.clamp((point.temperature + 30) / 70, 0, 1);
    mesh.setColorAt(index, cool.clone().lerp(warm, temperatureMix));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

function createSatelliteLayer(points: Point[]) {
  const stride = Math.max(1, Math.ceil(points.length / 72));
  const rendered = points.filter((_, index) => index % stride === 0);
  const group = new THREE.Group();
  const body = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.018, 0.04, 0.018),
    new THREE.MeshPhongMaterial({ color: 0xdce4e9, shininess: 70 }),
    rendered.length,
  );
  const panels = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.085, 0.005, 0.027),
    new THREE.MeshPhongMaterial({ color: 0x2768c7, emissive: 0x082452, shininess: 90 }),
    rendered.length,
  );
  const matrix = new THREE.Matrix4();
  rendered.forEach((point, index) => {
    const transform = surfaceTransform(point, 2.09, 0.000035);
    matrix.compose(transform.position, transform.quaternion, new THREE.Vector3(1, 1, 1));
    body.setMatrixAt(index, matrix);
    panels.setMatrixAt(index, matrix);
  });
  body.instanceMatrix.needsUpdate = true;
  panels.instanceMatrix.needsUpdate = true;
  group.add(body, panels);
  return group;
}

function createAircraftLayer(points: Point[]) {
  const stride = Math.max(1, Math.ceil(points.length / 180));
  const rendered = points.filter((_, index) => index % stride === 0);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0.003, 0.065, -0.012, 0, -0.025, 0.012, 0, -0.025,
    -0.012, 0, 0.005, -0.065, 0, -0.026, -0.012, 0, -0.035,
    0.012, 0, 0.005, 0.012, 0, -0.035, 0.065, 0, -0.026,
    -0.012, 0, -0.025, -0.027, 0, -0.055, 0, 0, -0.042,
    0.012, 0, -0.025, 0, 0, -0.042, 0.027, 0, -0.055,
  ], 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
    rendered.length,
  );
  const matrix = new THREE.Matrix4();
  const heading = new THREE.Quaternion();
  rendered.forEach((point, index) => {
    const transform = surfaceTransform(point, 2.045, 0.000002);
    heading.setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(point.longitude * 3 + point.latitude));
    transform.quaternion.multiply(heading);
    matrix.compose(transform.position, transform.quaternion, new THREE.Vector3(0.72, 0.72, 0.72));
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function disposeLayers(group: THREE.Group) {
  group.traverse((object) => {
    if (object instanceof THREE.Points || object instanceof THREE.Mesh) {
      object.geometry.dispose();
      (Array.isArray(object.material) ? object.material : [object.material])
        .forEach((material) => material.dispose());
    }
  });
  group.clear();
}

function createEarthSurface(renderer: THREE.WebGLRenderer) {
  const loader = new THREE.TextureLoader();
  const diffuse = loader.load('/earth-diffuse.jpg');
  const normal = loader.load('/earth-normal.jpg');
  const specular = loader.load('/earth-specular.jpg');
  diffuse.colorSpace = THREE.SRGBColorSpace;
  diffuse.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return new THREE.Mesh(
    new THREE.SphereGeometry(1.985, 128, 96),
    new THREE.MeshPhongMaterial({
      map: diffuse,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.65, 0.65),
      specularMap: specular,
      specular: new THREE.Color(0x506b83),
      shininess: 18,
    }),
  );
}

function createClouds() {
  const texture = new THREE.TextureLoader().load('/earth-clouds.png');
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(
    new THREE.SphereGeometry(2.003, 128, 96),
    new THREE.MeshPhongMaterial({
      map: texture,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
}

function createStars() {
  const positions = new Float32Array(1_800 * 3);
  for (let index = 0; index < 1_800; index += 1) {
    const radius = 28 + Math.random() * 35;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = radius * Math.cos(phi);
    positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ color: 0xc9d7e8, size: 0.65, sizeAttenuation: false, opacity: 0.65, transparent: true }),
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
  const layerObjectsRef = useRef<THREE.Object3D[]>([]);
  const pixelRatioRef = useRef(1);
  const [status, setStatus] = useState<SceneStatus>('loading');
  const [counts, setCounts] = useState<Counts>({ weather: 0, aircraft: 0, satellites: 0 });
  const [updatedAt, setUpdatedAt] = useState<string>();
  const [visibleLayers, setVisibleLayers] = useState([true, true, true]);

  useEffect(() => {
    layerObjectsRef.current.forEach((layer, index) => { layer.visible = visibleLayers[index]; });
  }, [visibleLayers]);

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
        const layerObjects = [
          createWeatherLayer(payload.weather.data),
          createSatelliteLayer(payload.satellites.data),
          createAircraftLayer(payload.aircraft.data),
        ];
        layerObjects.forEach((layer, index) => { layer.visible = visibleLayers[index]; });
        layerObjectsRef.current = layerObjects;
        layers.add(...layerObjects);
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
  }, [visibleLayers]);

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
    const earth = createEarthSurface(renderer);
    const clouds = createClouds();
    globe.add(earth, clouds, createAtmosphere());
    const layers = new THREE.Group();
    layersRef.current = layers;
    globe.add(layers);
    scene.add(globe, createStars());
    scene.add(new THREE.HemisphereLight(0x8eb8e8, 0x02040a, 0.72));
    const sunlight = new THREE.DirectionalLight(0xffffff, 2.8);
    sunlight.position.set(-4, 2.2, 5);
    scene.add(sunlight);

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
      cameraDistance = camera.aspect < 0.9 ? 8.4 : 6.7;
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
      clouds.rotation.y += 0.000025;
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
          <button key={label} type="button" className="layer-control" onClick={() => setVisibleLayers((current) => current.map((value, item) => item === index ? !value : value))}>
            <Icon aria-hidden="true" />
            <span>{label}</span>
            <small>{count.toLocaleString()}</small>
            <span className={`layer-toggle${visibleLayers[index] ? ' is-on' : ''}`} aria-label={`${label} ${visibleLayers[index] ? 'on' : 'off'}`} />
          </button>
        ))}
      </div>
      <span className="sr-only">{total.toLocaleString()} live data points</span>
    </div>
  );
}
