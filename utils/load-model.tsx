/** @jsx createElementEntity */
import { Object3D } from "three";
import { createElementEntity } from "../utils/jsx-entity";
import { HubsWorld } from "../app";
import { loadModel as loadGLTFModel } from "../components/gltf-model-plus";
import { renderAsEntity } from "../utils/jsx-entity";

const TRIGGER_NAME_PATTERNS = [/_interactive_animation/, /_proximity_(near|medium|far)/];

function hasTriggerNamedDescendant(root: Object3D): boolean {
  let found = false;
  root.traverse(child => {
    if (found || !child.name) return;
    const stripped = child.name.replace(/\.(glb|gltf|fbx|obj)$/i, "");
    if (TRIGGER_NAME_PATTERNS.some(p => p.test(stripped))) found = true;
  });
  return found;
}

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

  // Suppress auto-play if the model contains any trigger-named objects — those animations
  // are meant to be controlled by the trigger systems (interactive / proximity), not looped on load.
  const effectiveAutoPlay = autoPlayAnimations && !hasTriggerNamedDescendant(scene);

  return renderAsEntity(world, <entity model={{ model: scene, autoPlayAnimations: effectiveAutoPlay }} objectMenuTarget />);
}
