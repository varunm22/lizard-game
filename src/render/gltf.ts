import * as THREE from 'three';
import { GLTFLoader, type GLTF, type GLTFParser } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Load a GLB by URL. The single-file preview build inlines models as data: URLs; those are decoded
 * here rather than fetched, since strict Content-Security-Policies (like the claude.ai preview) block that.
 */
export function loadGltf(url: string): Promise<GLTF> {
  const loader = new GLTFLoader().register(decodeEmbeddedImages);
  return url.startsWith('data:') ? loader.parseAsync(dataUrlToBuffer(url), '') : loader.loadAsync(url);
}

function dataUrlToBuffer(url: string): ArrayBuffer {
  const bytes = atob(url.slice(url.indexOf(',') + 1));
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return buf.buffer;
}

/**
 * GLTFLoader turns an image embedded in a GLB into a blob: URL and fetches it, which strict
 * Content-Security-Policies refuse. Decode the bytes directly instead.
 */
function decodeEmbeddedImages(parser: GLTFParser) {
  const original = parser.loadImageSource.bind(parser);
  const cache = new Map<number, Promise<THREE.Texture>>();
  parser.loadImageSource = (sourceIndex: number, loader: THREE.Loader) => {
    const def = parser.json.images[sourceIndex];
    if (def.bufferView === undefined) return original(sourceIndex, loader);
    if (!cache.has(sourceIndex)) cache.set(sourceIndex, parser.getDependency('bufferView', def.bufferView).then(async (data: ArrayBuffer) => {
      const bitmap = await createImageBitmap(new Blob([data], { type: def.mimeType }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const texture = new THREE.Texture(bitmap);
      texture.needsUpdate = true;
      texture.userData.mimeType = def.mimeType;
      return texture;
    }));
    return cache.get(sourceIndex)!.then((t) => t.clone());
  };
  return { name: 'decode_embedded_images' };
}
