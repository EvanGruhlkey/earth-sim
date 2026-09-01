import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve('dist/cesium');
const destination = resolve('dist/client/cesium');

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });

