import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Load a GLB by URL. The single-file preview build inlines models as data: URLs; those are decoded
 * here rather than fetched, since strict Content-Security-Policies (like the claude.ai preview) block that.
 */
export function loadGltf(url: string): Promise<GLTF> {
  const loader = new GLTFLoader();
  return url.startsWith('data:') ? loader.parseAsync(dataUrlToBuffer(url), '') : loader.loadAsync(url);
}

function dataUrlToBuffer(url: string): ArrayBuffer {
  const bytes = atob(url.slice(url.indexOf(',') + 1));
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return buf.buffer;
}
