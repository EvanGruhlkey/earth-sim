'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

const WEATHER_POINTS = 2_000_000;
const AIRCRAFT_POINTS = 120_000;
const SATELLITE_POINTS = 12_000;
const TOTAL_POINTS = WEATHER_POINTS + AIRCRAFT_POINTS + SATELLITE_POINTS;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

type SceneStatus = 'loading' | 'ready' | 'unsupported';

function fractional(value: number) {
  return value - Math.floor(value);
}

function deterministicRandom(index: number, salt: number) {
  return fractional(Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453);
}

function createWeatherLayer(pixelRatio: number) {
  const positions = new Float32Array(WEATHER_POINTS * 3);
  const intensity = new Float32Array(WEATHER_POINTS);

  for (let index = 0; index < WEATHER_POINTS; index += 1) {
    const y = 1 - (2 * (index + 0.5)) / WEATHER_POINTS;
    const ringRadius = Math.sqrt(1 - y * y);
    const longitude = index * GOLDEN_ANGLE;
    const radius = 2.012 + deterministicRandom(index, 4) * 0.014;
    const offset = index * 3;

    positions[offset] = Math.cos(longitude) * ringRadius * radius;
    positions[offset + 1] = y * radius;
    positions[offset + 2] = Math.sin(longitude) * ringRadius * radius;

    const band = Math.sin(longitude * 2.3 + y * 17);
    const cell = Math.sin(longitude * 7.1 - y * 31);
    intensity[index] = Math.max(0, Math.min(1, band * 0.28 + cell * 0.22 + 0.5));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aIntensity', new THREE.BufferAttribute(intensity, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
    },
    vertexShader: `
      attribute float aIntensity;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vIntensity;

      mat3 rotateY(float angle) {
        float c = cos(angle);
        float s = sin(angle);
        return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
      }

      void main() {
        float latitude = normalize(position).y;
        float flow = uTime * (0.006 + aIntensity * 0.005) * (1.0 - abs(latitude) * 0.35);
        vec3 animatedPosition = rotateY(flow) * position;
        vec4 mvPosition = modelViewMatrix * vec4(animatedPosition, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = (0.62 + aIntensity * 0.92) * uPixelRatio;
        vIntensity = aIntensity;
      }
    `,
    fragmentShader: `
      varying float vIntensity;

      void main() {
        vec2 centered = gl_PointCoord - vec2(0.5);
        float alpha = smoothstep(0.5, 0.08, length(centered));
        vec3 cool = vec3(0.12, 0.71, 0.72);
        vec3 warm = vec3(0.96, 0.62, 0.24);
        vec3 color = mix(cool, warm, smoothstep(0.47, 0.9, vIntensity));
        gl_FragColor = vec4(color, alpha * (0.18 + vIntensity * 0.38));
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.name = 'weather';
  return { points, material };
}

function createAircraftLayer(pixelRatio: number) {
  const positions = new Float32Array(AIRCRAFT_POINTS * 3);

  for (let index = 0; index < AIRCRAFT_POINTS; index += 1) {
    const longitude = deterministicRandom(index, 9) * Math.PI * 2;
    const latitudeSample =
      deterministicRandom(index, 11) +
      deterministicRandom(index, 13) +
      deterministicRandom(index, 15) -
      1.5;
    const latitude = latitudeSample * 0.94;
    const radius = 2.035 + deterministicRandom(index, 17) * 0.012;
    const latitudeRadius = Math.cos(latitude) * radius;
    const offset = index * 3;

    positions[offset] = Math.cos(longitude) * latitudeRadius;
    positions[offset + 1] = Math.sin(latitude) * radius;
    positions[offset + 2] = Math.sin(longitude) * latitudeRadius;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0xffbd66,
    size: 1.28 * pixelRatio,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.82,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.name = 'aircraft';
  return points;
}

function createSatelliteLayer(pixelRatio: number) {
  const positions = new Float32Array(SATELLITE_POINTS * 3);

  for (let index = 0; index < SATELLITE_POINTS; index += 1) {
    const plane = index % 72;
    const phase = (index / SATELLITE_POINTS) * Math.PI * 2 * 43;
    const inclination = 0.35 + (plane % 12) * 0.095;
    const ascendingNode = (plane / 72) * Math.PI * 2;
    const altitude = 2.16 + (plane % 9) * 0.035;
    const orbitalX = Math.cos(phase) * altitude;
    const orbitalY = Math.sin(phase) * altitude;
    const offset = index * 3;

    positions[offset] =
      Math.cos(ascendingNode) * orbitalX -
      Math.sin(ascendingNode) * Math.cos(inclination) * orbitalY;
    positions[offset + 1] = Math.sin(inclination) * orbitalY;
    positions[offset + 2] =
      Math.sin(ascendingNode) * orbitalX +
      Math.cos(ascendingNode) * Math.cos(inclination) * orbitalY;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0xd9f7ff,
    size: 1.45 * pixelRatio,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.74,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.name = 'satellites';
  return points;
}

function createEarthSurface() {
  const geometry = new THREE.SphereGeometry(1.985, 128, 96);
  const material = new THREE.ShaderMaterial({
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
  });

  return new THREE.Mesh(geometry, material);
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
  const [status, setStatus] = useState<SceneStatus>('loading');
  const [fps, setFps] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      powerPreference: 'high-performance',
    });

    if (!context) {
      queueMicrotask(() => setStatus('unsupported'));
      return;
    }

    host.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: false });
    const pixelRatio = Math.min(window.devicePixelRatio, 1.6);
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x03080b, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0.15, 6.7);

    const globe = new THREE.Group();
    globe.rotation.set(-0.12, -0.58, -0.18);
    scene.add(globe);

    globe.add(createEarthSurface());
    globe.add(createAtmosphere());

    const weather = createWeatherLayer(pixelRatio);
    const aircraft = createAircraftLayer(pixelRatio);
    const satellites = createSatelliteLayer(pixelRatio);
    globe.add(weather.points, aircraft, satellites);

    let pointerDown = false;
    let previousX = 0;
    let previousY = 0;
    let velocityX = 0;
    let velocityY = 0;
    let cameraDistance = 6.7;
    let animationFrame = 0;
    let lastFrame = performance.now();
    let statsStarted = lastFrame;
    let frames = 0;

    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };

    const onPointerDown = (event: PointerEvent) => {
      pointerDown = true;
      previousX = event.clientX;
      previousY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('is-grabbing');
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!pointerDown) return;
      velocityX = (event.clientX - previousX) * 0.0038;
      velocityY = (event.clientY - previousY) * 0.0038;
      globe.rotation.y += velocityX;
      globe.rotation.x = THREE.MathUtils.clamp(globe.rotation.x + velocityY, -1.25, 1.25);
      previousX = event.clientX;
      previousY = event.clientY;
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

    const render = (now: number) => {
      const delta = Math.min((now - lastFrame) / 1000, 0.05);
      lastFrame = now;
      frames += 1;

      if (!pointerDown) {
        globe.rotation.y += 0.022 * delta + velocityX;
        globe.rotation.x = THREE.MathUtils.clamp(globe.rotation.x + velocityY, -1.25, 1.25);
        velocityX *= 0.93;
        velocityY *= 0.93;
      }

      camera.position.z = THREE.MathUtils.lerp(camera.position.z, cameraDistance, 0.09);
      weather.material.uniforms.uTime.value = now / 1000;
      satellites.rotation.y = now * 0.000012;
      aircraft.rotation.y = now * 0.000004;
      renderer.render(scene, camera);

      if (now - statsStarted >= 750) {
        setFps(Math.round((frames * 1000) / (now - statsStarted)));
        frames = 0;
        statsStarted = now;
      }

      animationFrame = requestAnimationFrame(render);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(host);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    resize();
    queueMicrotask(() => setStatus('ready'));
    animationFrame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      renderer.dispose();
      canvas.remove();
    };
  }, []);

  return (
    <div ref={hostRef} className="earth-scene" aria-label="Interactive real-time Earth data globe">
      <div className="earth-scene__readout" aria-live="polite">
        <span className={`status-dot status-dot--${status}`} />
        {status === 'loading' && 'Allocating GPU buffers'}
        {status === 'ready' && `${TOTAL_POINTS.toLocaleString()} points · ${fps || '—'} FPS`}
        {status === 'unsupported' && 'WebGL 2 is required'}
      </div>
      <p className="earth-scene__hint">Drag to orbit · Scroll to zoom</p>
    </div>
  );
}
