import { writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

globalThis.FileReader ??= class FileReader {
  result = null;
  onloadend = null;

  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((value) => {
      this.result = value;
      this.onloadend?.();
    });
  }
};

const satellite = new THREE.Group();
const metal = new THREE.MeshStandardMaterial({ color: 0xdce4e9, metalness: 0.8, roughness: 0.25 });
const solar = new THREE.MeshStandardMaterial({ color: 0x185cb5, metalness: 0.65, roughness: 0.3 });
const dark = new THREE.MeshStandardMaterial({ color: 0x202a34, metalness: 0.7, roughness: 0.35 });

satellite.add(new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.1, 1.5), metal));

const panelGeometry = new THREE.BoxGeometry(2.8, 0.08, 1.25);
const leftPanel = new THREE.Mesh(panelGeometry, solar);
leftPanel.position.x = -2;
const rightPanel = new THREE.Mesh(panelGeometry, solar);
rightPanel.position.x = 2;
satellite.add(leftPanel, rightPanel);

const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.5, 12), dark);
antenna.position.y = 1.2;
satellite.add(antenna);

const dish = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.28, 24, 1, true), metal);
dish.position.y = 2;
dish.rotation.x = Math.PI;
satellite.add(dish);

const exporter = new GLTFExporter();
const data = await exporter.parseAsync(satellite, { binary: true, onlyVisible: true });
await writeFile(new URL('../public/satellite.glb', import.meta.url), new Uint8Array(data));

