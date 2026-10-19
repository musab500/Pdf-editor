import { FaceRegistry } from "../text/fontFaces";
import type { Asset } from "../model/types";

/** Face registry for browser contexts (main thread or worker): fonts are fetched from this app's own origin. */
export function browserFaceRegistry(customFonts: () => Record<string, Asset>): FaceRegistry {
  return new FaceRegistry(
    async (file) => {
      const res = await fetch(`/fonts/${file}`);
      if (!res.ok) throw new Error(`Font ${file} could not be loaded (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async (assetId) => {
      const a = customFonts()[assetId];
      return a ? { bytes: a.bytes, name: a.name } : undefined;
    },
  );
}
