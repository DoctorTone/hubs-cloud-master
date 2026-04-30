/** @jsx createElementEntity */
import { createElementEntity } from "../utils/jsx-entity";
import { HubsWorld } from "../app";
import { loadModel as loadGLTFModel } from "../components/gltf-model-plus";
import { renderAsEntity } from "../utils/jsx-entity";

export function* loadModel(world: HubsWorld, src: string, contentType: string, useCache: boolean, autoPlayAnimations = true, displayName?: string) {
  // TODO: Write loadGLTFModelCancelable
  const { scene, animations } = yield loadGLTFModel(src, contentType, useCache, null);

  scene.animations = animations;
  scene.mixer = new THREE.AnimationMixer(scene);

  // Use the original upload filename so indirect animation target naming conventions work.
  if (displayName) {
    const baseName = displayName.replace(/\.(glb|gltf|fbx|obj)$/i, "");
    if (baseName) {
      scene.name = baseName;
    }
  }

  return renderAsEntity(world, <entity model={{ model: scene, autoPlayAnimations }} objectMenuTarget />);
}
