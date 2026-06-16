import { addComponent, addEntity, hasComponent } from "bitecs";
import { Material, Mesh, Object3D } from "three";
import { HubsWorld } from "../app";
import { GLTFModel, MaterialTag, MixerAnimatableInitialize } from "../bit-components";
import { addMaterialComponent, addObject3DComponent, gltfInflatorExists, gltfInflators } from "../utils/jsx-entity";
import { mapMaterials } from "../utils/material-utils";
import { EntityID } from "../utils/networking-types";
import { inflateLoopAnimationInitialize, LoopAnimationParams } from "./loop-animation";

function camelCase(s: string) {
  return s.replace(/-(\w)/g, (_, m) => m.toUpperCase());
}

// Objects whose name marks them as interactive/proximity animation triggers. Their clips are
// played on demand by the trigger systems, so they must not be auto-played (looped) on load.
const TRIGGER_NAME_PATTERNS = [/_interactive_animation/, /_proximity_(near|medium|far)/];
function isTriggerName(name?: string): boolean {
  if (!name) return false;
  const stripped = name.replace(/\.(glb|gltf|fbx|obj)$/i, "");
  return TRIGGER_NAME_PATTERNS.some(p => p.test(stripped));
}

export type ModelParams = { model: Object3D; autoPlayAnimations?: boolean };

// These components are all handled in some special way, not through inflators
const ignoredComponents = [
  "visible",
  "frustum",
  "frustrum",
  "shadow",
  "networked",
  "animation-mixer",
  "loop-animation"
];

function inflateComponents(
  world: HubsWorld,
  eid: number,
  components: { [componentName: string]: any },
  idx2eid: Map<number, EntityID>
) {
  Object.keys(components).forEach(name => {
    if (ignoredComponents.includes(name)) return;
    const inflatorName = camelCase(name);
    if (!gltfInflatorExists(inflatorName)) {
      console.warn(`Failed to inflate unknown component called ${inflatorName}`, components[name]);
      return;
    }

    const props = components[name];
    Object.keys(props).forEach(propName => {
      const value = props[propName];
      const linkType = value?.__mhc_link_type;
      if (linkType) {
        if (linkType !== "node") {
          throw new Error("Non node link types should be resolved before inflateModel is called");
        }
        const existingEid = idx2eid.get(value.index);
        if (existingEid) {
          props[propName] = existingEid;
        } else {
          props[propName] = addEntity(world);
          idx2eid.set(value.index, props[propName]);
        }
      }
    });
    gltfInflators[inflatorName](world, eid, props);
  });
}

export function inflateModel(world: HubsWorld, rootEid: number, { model, autoPlayAnimations = true }: ModelParams) {
  const swap: [old: Object3D, replacement: Object3D][] = [];
  const idx2eid = new Map<number, number>();
  model.traverse(obj => {
    const gltfIndex: number | undefined = obj.userData.gltfIndex;

    let eid: number;
    if (obj === model) {
      eid = rootEid;
    } else if (gltfIndex !== undefined && idx2eid.has(gltfIndex)) {
      eid = idx2eid.get(gltfIndex)!;
    } else {
      eid = addEntity(world);
    }

    if (gltfIndex !== undefined) idx2eid.set(gltfIndex, eid);

    const components = obj.userData.gltfExtensions?.MOZ_hubs_components;
    if (components) inflateComponents(world, eid, components, idx2eid);

    mapMaterials(obj, function (mat: Material) {
      const eid = mat.eid || addEntity(world);
      if (!hasComponent(world, MaterialTag, eid)) addMaterialComponent(world, eid, mat);
      const components = mat.userData.gltfExtensions?.MOZ_hubs_components;
      if (components) inflateComponents(world, eid, components, idx2eid);
    });

    const replacement = world.eid2obj.get(eid);
    if (replacement) {
      if (obj.type !== "Object3D") {
        console.error(obj, replacement);
        throw new Error("Failed to inflate model. Unexpected object type found before swap.");
      }
      if (obj === model) {
        throw new Error("Failed to inflate model. Can't inflate alternative object type on root scene.");
      }
      if (replacement instanceof Mesh) replacement.reflectionProbeMode = "dynamic";
      swap.push([obj, replacement]);
    } else {
      if (obj instanceof Mesh) obj.reflectionProbeMode = "dynamic";
      addObject3DComponent(world, eid, obj);
    }
  });

  swap.forEach(([old, replacement]) => {
    for (let i = old.children.length - 1; i >= 0; i--) {
      replacement.add(old.children[i]);
    }
    replacement.position.copy(old.position);
    replacement.quaternion.copy(old.quaternion);
    replacement.scale.copy(old.scale);
    replacement.matrixNeedsUpdate = true;
    // Re-use the the uuid for animation targeting.
    // TODO: This is weird... Should we be rewriting the animations instead?
    replacement.uuid = old.uuid;

    old.parent!.add(replacement);
    old.removeFromParent();
  });

  // These components are special because we want to do a one-off action
  // that we can't do in a regular inflator (because they depend on the object3D).
  // If more things need to run at this point, we may need to expand the api here.
  // Collect the subtrees of any trigger-named objects so their loop-animation clips can be
  // excluded from auto-play below — the interactive/proximity systems drive those instead.
  const triggerNamedUuids = new Set<string>();
  const dbgTriggerNames: string[] = [];
  model.traverse(obj => {
    if (isTriggerName(obj.name)) {
      dbgTriggerNames.push(obj.name);
      obj.traverse(child => triggerNamedUuids.add(child.uuid));
    }
  });
  const modelHasTriggers = triggerNamedUuids.size > 0;
  const loopAnimationParams: LoopAnimationParams = [];
  model.traverse(obj => {
    const components = obj.userData.gltfExtensions?.MOZ_hubs_components || {};
    if (components.visible) {
      const { visible } = components.visible;
      obj.visible = visible;
    }

    if (components.shadow) {
      const { cast, receive } = components.shadow;
      obj.traverse(o => {
        o.castShadow = cast;
        o.receiveShadow = receive;
      });
    }

    // Skip loop-animation on trigger-named objects so they don't auto-loop on load.
    if (components["loop-animation"]) {
      const excluded = triggerNamedUuids.has(obj.uuid);
      console.warn(
        `[anim-debug] (model) "${model.name}" loop-animation on "${obj.name}" excluded=${excluded}`,
        components["loop-animation"]
      );
      if (!excluded) loopAnimationParams.push(components["loop-animation"]);
    }

    // We have had both spellings at different times.
    if (components.frustrum) {
      components.frustum = components.frustrum;
    }

    if (components.frustum) {
      const { culled } = components.frustum;
      obj.traverse(o => {
        o.frustumCulled = culled;
      });
    }
  });

  // Hubs loop-animation component is defined at glTF node level.
  // The component data are collected above in the scene graph traverse and
  // bitECS LoopAnimation Component is set to root entity for simpler implementation.
  // TODO: Probably the Hubs loop-animation component should be defined at scene
  //       or root level. Revisit the specification.
  // See https://github.com/Hubs-Foundation/hubs/pull/5938#discussion_r1163410185
  if (model.animations !== undefined && model.animations.length > 0) {
    addComponent(world, MixerAnimatableInitialize, rootEid);
    // When the model contains trigger-named objects, only auto-play if non-trigger
    // loop-animation clips remain, and never fall back to the default (clip 0) — that clip
    // could belong to a trigger. Models without triggers keep the original behaviour
    // (including the clip-0 default when no loop-animation components are present).
    const willAutoPlay = autoPlayAnimations && (!modelHasTriggers || loopAnimationParams.length > 0);
    if (willAutoPlay) {
      inflateLoopAnimationInitialize(world, rootEid, loopAnimationParams);
    }
  }

  addComponent(world, GLTFModel, rootEid);
}
