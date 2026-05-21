import { addComponent, defineQuery, enterQuery, exitQuery, hasComponent, removeComponent } from "bitecs";
import { AnimationMixer, Box3, LoopOnce, LoopRepeat, Object3D, Vector3 } from "three";
import { HubsWorld } from "../app";
import {
  AnimationOnClick,
  CursorRaycastable,
  Held,
  Holdable,
  Interacted,
  LoopAnimation,
  LoopAnimationInitialize,
  MixerAnimatableData,
  NetworkedAnimationOnClick,
  Object3DTag,
  ObjectSpawner,
  OffersRemoteConstraint,
  RemoteHoverTarget,
  SingleActionButton
} from "../bit-components";
import { localClientID } from "../bit-systems/networking";

const ANIMATION_NAME_TAG = "_interactive_animation";
const NAF_DATA_TYPE = "animation-play";

const enum TriggerMode {
  Desktop, // click only (default)
  Hand, // VR hand only
  Both // click + VR hand
}

const mixers = new Map<number, AnimationMixer>();
const animRoots = new Map<number, Object3D>();
const triggerUUIDs = new Map<number, Set<string>>();
const lastPlayCount = new Map<number, number>();
const nameToEid = new Map<string, number>();

// Linked target animation support
const targetName = new Map<number, string>(); // eid -> target object name suffix
const targetMixersList = new Map<number, AnimationMixer[]>();
const targetRootsList = new Map<number, Object3D[]>();
const targetUUIDsList = new Map<number, Set<string>[]>();

// VR hand trigger support
const triggerMode = new Map<number, TriggerMode>();
const handBounds = new Map<number, Box3>();
const handInside = new Map<number, boolean>(); // debounce: true while hand is inside

// _loop suffix support: looping triggers toggle on/off with each click instead of
// playing once. Loop only applies to direct animation (no _<target> suffix).
const loopMode = new Map<number, boolean>();
const loopPlaying = new Map<number, boolean>();

// _clip_<name> suffix support: trigger plays one specific named clip on its target.
// While the clip is playing, further clicks on any clip-trigger sharing the same target
// are ignored — the user is locked into their choice until it finishes.
const clipName = new Map<number, string>();
const targetLockUntil = new Map<string, number>();

// Names referenced as indirect-animation targets across all triggers. Used to suppress
// auto-play (LoopAnimation) on objects that are targets — they should only animate when
// their trigger is clicked, not loop on scene load.
const registeredTargets = new Set<string>();

let nafHandlerRegistered = false;

const newObjectQuery = enterQuery(defineQuery([Object3DTag]));
const animQuery = defineQuery([AnimationOnClick, SingleActionButton]);
const animEnterQuery = enterQuery(animQuery);
const animExitQuery = exitQuery(animQuery);
const clickedQuery = enterQuery(defineQuery([AnimationOnClick, NetworkedAnimationOnClick, SingleActionButton, Interacted]));
const networkedAnimQuery = defineQuery([AnimationOnClick, NetworkedAnimationOnClick]);
const heldAnimEnterQuery = enterQuery(defineQuery([AnimationOnClick, Held]));
const heldAnimExitQuery = exitQuery(defineQuery([AnimationOnClick, Held]));

// Click-vs-hold thresholds: a release within this time and distance counts as a click
// (animate); anything longer or further is treated as a drag (no animation).
const CLICK_DURATION_MS = 250;
const CLICK_DISTANCE_M = 0.05;
const heldStartTime = new Map<number, number>();
const heldStartPos = new Map<number, Vector3>();

// Reusable vectors for hand position checks
const controllerPos = new Vector3();
const tmpBox = new Box3();
const tmpPos = new Vector3();

function ensureNafHandler() {
  if (nafHandlerRegistered) return;
  nafHandlerRegistered = true;
  NAF.connection.subscribeToDataChannel(NAF_DATA_TYPE, (_senderId: string, _dataType: string, data: { name: string }) => {
    const eid = nameToEid.get(data.name);
    if (eid !== undefined) {
      NetworkedAnimationOnClick.playing[eid]++;
    }
  });
}

// Walk up the hierarchy to find the nearest ancestor that has animation clips,
// and continue walking to find the AFrame animation-mixer component if present.
// Both live on different ancestors because gltf-model-plus sets animations on
// gltf.scene while the AFrame animation-mixer sits one level higher on el.object3D.
function findAnimationContext(obj: Object3D): { root: Object3D; aframeMixer: AnimationMixer | null } | null {
  let root: Object3D | null = null;
  let aframeMixer: AnimationMixer | null = null;
  let current: Object3D | null = obj;

  while (current) {
    if (!root && current.animations?.length > 0) root = current;
    if (!aframeMixer) {
      const mixer = (current.el as any)?.components?.["animation-mixer"]?.mixer;
      if (mixer) aframeMixer = mixer;
    }
    if (root && aframeMixer) break;
    current = current.parent;
  }

  return root ? { root, aframeMixer } : null;
}

// Stop only the clip actions whose tracks reference the given entity's descendant UUIDs,
// rather than calling stopAllAction() which would kill unrelated animations on a shared mixer.
function stopClipsForEntity(
  ctx: { root: Object3D; aframeMixer: AnimationMixer | null },
  uuids: Set<string>,
  obj: Object3D
) {
  if (!ctx.root.animations) return;
  const myClips = ctx.root.animations.filter(clip =>
    clip.tracks.some(track => uuids.has(track.name.split(".")[0]))
  );
  const bitecsMixer = ctx.root.eid !== undefined ? MixerAnimatableData.get(ctx.root.eid) : null;
  for (const clip of myClips) {
    if (bitecsMixer) {
      bitecsMixer.clipAction(clip, obj).stop();
    }
    if (ctx.aframeMixer) {
      ctx.aframeMixer.clipAction(clip, obj).stop();
    }
  }
}

// Does `objName` (extension-stripped) match `tName` either exactly or as TargetName_N?
function targetNameMatches(objName: string, tName: string): boolean {
  const stripExt = (s: string) => s.replace(/\.(glb|gltf|fbx|obj)$/i, "");
  const cleanName = stripExt(objName);
  const cleanT = stripExt(tName);
  if (cleanName === cleanT) return true;
  const suffixPattern = new RegExp(`^${cleanT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_\\d+$`);
  return suffixPattern.test(cleanName);
}

// Walk up from `obj` and remove LoopAnimation (or its Initialize variant) from the first
// ancestor entity that carries it. Removing LoopAnimation triggers loopAnimationSystem's
// exit query, which stops the cached actions properly — avoiding the clipAction(clip, obj)
// vs clipAction(clip, root) action-mismatch that plagues direct mixer.stop() calls here.
function suppressLoopAnimationOnTarget(world: HubsWorld, obj: Object3D) {
  let current: Object3D | null = obj;
  while (current) {
    const eid = (current as any).eid as number | undefined;
    if (eid !== undefined) {
      if (hasComponent(world, LoopAnimationInitialize, eid)) {
        removeComponent(world, LoopAnimationInitialize, eid);
        return;
      }
      if (hasComponent(world, LoopAnimation, eid)) {
        removeComponent(world, LoopAnimation, eid);
        return;
      }
    }
    current = current.parent;
  }
}

// Find all scene objects matching the target name exactly or as TargetName_N.
// The GLTF loader auto-disambiguates duplicate names by appending _1, _2, etc.,
// so naming several Spoke objects the same thing produces this suffix pattern.
// File extensions on either side are stripped so dropped-in models like "robot.glb"
// match a target written as "robot".
function findSceneObjectsByTargetName(name: string): Object3D[] {
  const scene = AFRAME.scenes[0]?.object3D;
  if (!scene) return [];
  const stripExt = (s: string) => s.replace(/\.(glb|gltf|fbx|obj)$/i, "");
  const cleanName = stripExt(name);
  const suffixPattern = new RegExp(`^${cleanName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_\\d+$`);
  const results: Object3D[] = [];
  scene.traverse((child: Object3D) => {
    if (!child.name) return;
    const childName = stripExt(child.name);
    if (childName === cleanName || suffixPattern.test(childName)) {
      results.push(child);
    }
  });
  return results;
}

// Parse the suffix after _interactive_animation to extract mode, optional target,
// optional trailing _loop flag, and optional _clip_<name> selector.
function parseSuffix(suffix: string): {
  mode: TriggerMode;
  target: string | null;
  loop: boolean;
  clip: string | null;
} {
  let s = suffix;
  let loop = false;
  let clip: string | null = null;

  if (s === "loop") {
    loop = true;
    s = "";
  } else if (s.endsWith("_loop")) {
    loop = true;
    s = s.substring(0, s.length - 5);
  }

  // Extract _clip_<name> (or leading clip_<name>) from the trailing portion.
  // Limitation: a target literally containing "_clip_" can't be expressed.
  const clipMatch = s.match(/(?:^|_)clip_(.+)$/);
  if (clipMatch) {
    clip = clipMatch[1];
    s = s.substring(0, clipMatch.index);
  }

  if (!s) return { mode: TriggerMode.Desktop, target: null, loop, clip };

  if (s === "hand") return { mode: TriggerMode.Hand, target: null, loop, clip };
  if (s === "both") return { mode: TriggerMode.Both, target: null, loop, clip };
  if (s.startsWith("hand_")) return { mode: TriggerMode.Hand, target: s.substring(5), loop, clip };
  if (s.startsWith("both_")) return { mode: TriggerMode.Both, target: s.substring(5), loop, clip };

  // No mode prefix — entire suffix is the target name, desktop mode
  return { mode: TriggerMode.Desktop, target: s, loop, clip };
}

// Compute world-space AABB for an object
function computeWorldBounds(obj: Object3D): Box3 {
  const box = new Box3();
  box.setFromObject(obj);
  return box;
}

// Get VR controller Object3Ds (cached references)
let leftController: Object3D | null = null;
let rightController: Object3D | null = null;

function getControllers(): { left: Object3D | null; right: Object3D | null } {
  if (!leftController) {
    const el = document.querySelector("#player-left-controller") as any;
    if (el?.object3D) leftController = el.object3D;
  }
  if (!rightController) {
    const el = document.querySelector("#player-right-controller") as any;
    if (el?.object3D) rightController = el.object3D;
  }
  return { left: leftController, right: rightController };
}

function playClips(
  mixer: AnimationMixer,
  root: Object3D,
  uuids: Set<string>,
  loop = false,
  selectClip: string | null = null
): number {
  let clips = root.animations.filter(clip =>
    clip.tracks.some(track => uuids.has(track.name.split(".")[0]))
  );
  if (selectClip) clips = clips.filter(c => c.name === selectClip);

  mixer.stopAllAction();
  let maxDuration = 0;
  for (const clip of clips) {
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = false;
    action.play();
    if (clip.duration > maxDuration) maxDuration = clip.duration;
  }
  return maxDuration;
}

function playAnimations(eid: number) {
  const root = animRoots.get(eid);
  const mixer = mixers.get(eid);
  const uuids = triggerUUIDs.get(eid);
  if (!root || !mixer || !uuids) return;

  const cName = clipName.get(eid) ?? null;

  // Looping triggers toggle: a click while playing stops the loop instead of restarting.
  if (loopMode.get(eid)) {
    if (loopPlaying.get(eid)) {
      mixer.stopAllAction();
      loopPlaying.set(eid, false);
      return;
    }
    loopPlaying.set(eid, true);
    playClips(mixer, root, uuids, true, cName);
    return;
  }

  // cName selects a clip on the target object, not on the source — don't filter source clips by it.
  playClips(mixer, root, uuids, false, null);

  // Also play linked target animations if configured
  playTargetAnimations(eid);
}

function playTargetAnimations(eid: number) {
  const tName = targetName.get(eid);
  if (!tName) return;

  const cName = clipName.get(eid) ?? null;
  const now = (APP as any).world?.time?.elapsed ?? performance.now();

  // Clip-specific triggers honour a per-target lock so a quiz answer can't be
  // changed mid-animation. Non-clip triggers ignore the lock (legacy behaviour).
  if (cName) {
    const lockUntil = targetLockUntil.get(tName) ?? 0;
    if (now < lockUntil) return;
  }

  // Resolve targets lazily each time so late-arriving objects (e.g. uploads) are found
  const tObjects = findSceneObjectsByTargetName(tName);
  if (tObjects.length === 0) return;

  // Stop any previously active target mixers
  targetMixersList.get(eid)?.forEach(m => m.stopAllAction());

  const mixerList: AnimationMixer[] = [];
  const rootList: Object3D[] = [];
  const uuidList: Set<string>[] = [];

  for (const tObj of tObjects) {
    const tCtx = findAnimationContext(tObj);
    if (!tCtx) continue;

    const tUuids = new Set<string>();
    tObj.traverse(child => tUuids.add(child.uuid));
    uuidList.push(tUuids);
    rootList.push(tCtx.root);
    mixerList.push(new AnimationMixer(tCtx.root));

    stopClipsForEntity(tCtx, tUuids, tObj);
  }

  // Cache for the update loop to tick, and play
  if (mixerList.length > 0) {
    targetMixersList.set(eid, mixerList);
    targetRootsList.set(eid, rootList);
    targetUUIDsList.set(eid, uuidList);

    let maxDuration = 0;
    for (let i = 0; i < mixerList.length; i++) {
      const dur = playClips(mixerList[i], rootList[i], uuidList[i], false, cName);
      if (dur > maxDuration) maxDuration = dur;
    }

    if (cName && maxDuration > 0) {
      targetLockUntil.set(tName, now + maxDuration * 1000);
    }
  }
}

// Check if either VR controller is inside the object's bounding box
function isControllerInside(eid: number): boolean {
  const bounds = handBounds.get(eid);
  if (!bounds) return false;

  // Recompute world bounds each frame (object may move)
  const obj = (APP as any).world?.eid2obj?.get(eid);
  if (obj) {
    tmpBox.setFromObject(obj);
  } else {
    tmpBox.copy(bounds);
  }

  const { left, right } = getControllers();

  if (left) {
    left.getWorldPosition(controllerPos);
    if (tmpBox.containsPoint(controllerPos)) return true;
  }
  if (right) {
    right.getWorldPosition(controllerPos);
    if (tmpBox.containsPoint(controllerPos)) return true;
  }

  return false;
}

export function animationPlaySystem(world: HubsWorld) {
  // Register NAF receive handler as soon as NAF is connected
  if (typeof NAF !== "undefined" && localClientID) {
    ensureNafHandler();
  }

  // Auto-tag any object whose name contains the marker string
  newObjectQuery(world).forEach(eid => {
    const obj = world.eid2obj.get(eid);
    if (!obj) return;
    // Spawners may be named "Spawner_<object_name>" so the spawned copies inherit
    // <object_name>; the spawner itself must not become an animation trigger.
    if (hasComponent(world, ObjectSpawner, eid)) return;
    // Strip common file extensions before checking for the animation tag
    const objName = obj.name.replace(/\.(glb|gltf|fbx|obj)$/i, "");

    // If this newly-entered object is a target of any already-registered trigger,
    // suppress its auto-play so it only animates when the trigger fires.
    if (objName) {
      for (const tName of registeredTargets) {
        if (targetNameMatches(objName, tName)) {
          suppressLoopAnimationOnTarget(world, obj);
          break;
        }
      }
    }

    if (!objName.includes(ANIMATION_NAME_TAG)) return;

    // Parse mode and target from the suffix
    const suffixStart = objName.indexOf(ANIMATION_NAME_TAG) + ANIMATION_NAME_TAG.length;
    let suffix = "";
    if (suffixStart < objName.length && objName[suffixStart] === "_") {
      suffix = objName.substring(suffixStart + 1);
    }
    const { mode, target, loop, clip } = parseSuffix(suffix);

    addComponent(world, AnimationOnClick, eid);
    addComponent(world, NetworkedAnimationOnClick, eid);
    addComponent(world, SingleActionButton, eid);
    nameToEid.set(obj.name, eid);
    triggerMode.set(eid, mode);
    // Loop only applies to direct animation; ignore the flag if a target was specified.
    if (loop && !target) loopMode.set(eid, true);
    if (clip) clipName.set(eid, clip);

    // Only add click/raycast components for desktop and both modes
    if (mode === TriggerMode.Desktop || mode === TriggerMode.Both) {
      addComponent(world, CursorRaycastable, eid);
      addComponent(world, RemoteHoverTarget, eid);
      // Make the trigger holdable so the cursor can grab it. A short release fires
      // the animation; a longer hold + cursor motion is treated as a drag instead.
      // hold-system gates this on canMove(), so non-grabbable Spoke objects continue
      // to fire via the existing Interacted path.
      addComponent(world, Holdable, eid);
      addComponent(world, OffersRemoteConstraint, eid);
    }

    if (target) {
      targetName.set(eid, target);
      // Register so future loads can suppress, and retroactively suppress any matching
      // objects already in the scene (target may have loaded before this trigger).
      registeredTargets.add(target);
      findSceneObjectsByTargetName(target).forEach(m => suppressLoopAnimationOnTarget(world, m));
    }

    // Set up bounding box for hand modes
    if (mode === TriggerMode.Hand || mode === TriggerMode.Both) {
      handBounds.set(eid, computeWorldBounds(obj));
      handInside.set(eid, false);
    }
  });

  // Set up mixer and suppress auto-play for newly tagged entities
  animEnterQuery(world).forEach(eid => {
    const obj = world.eid2obj.get(eid);
    if (!obj) return;
    const ctx = findAnimationContext(obj);
    if (!ctx) return;

    const uuids = new Set<string>();
    obj.traverse(child => uuids.add(child.uuid));
    triggerUUIDs.set(eid, uuids);

    animRoots.set(eid, ctx.root);
    mixers.set(eid, new AnimationMixer(ctx.root));
    lastPlayCount.set(eid, NetworkedAnimationOnClick.playing[eid]);

    // Stop auto-play only for clips belonging to this entity, leaving other
    // animations (e.g. Spoke auto-animate objects) on the shared mixer untouched.
    stopClipsForEntity(ctx, uuids, obj);

    // Target resolution is now done lazily in playTargetAnimations
    // so that objects uploaded after scene load are found
  });

  // Clean up when entity is removed
  animExitQuery(world).forEach(eid => {
    const obj = world.eid2obj.get(eid);
    if (obj) nameToEid.delete(obj.name);
    mixers.get(eid)?.stopAllAction();
    mixers.delete(eid);
    animRoots.delete(eid);
    triggerUUIDs.delete(eid);
    lastPlayCount.delete(eid);
    targetName.delete(eid);
    triggerMode.delete(eid);
    targetMixersList.get(eid)?.forEach(m => m.stopAllAction());
    targetMixersList.delete(eid);
    targetRootsList.delete(eid);
    targetUUIDsList.delete(eid);
    handBounds.delete(eid);
    handInside.delete(eid);
    loopMode.delete(eid);
    loopPlaying.delete(eid);
    clipName.delete(eid);
  });

  // Advance all active mixers (including linked targets)
  animQuery(world).forEach(eid => {
    const dt = world.time.delta / 1000.0;
    mixers.get(eid)?.update(dt);
    targetMixersList.get(eid)?.forEach(m => m.update(dt));
  });

  // On click: increment counter locally and broadcast to other clients by name.
  // Fires for non-grabbable triggers (Spoke wall buttons etc.) where holdSystem
  // never adds Held, so the cursor's hover stays and Interacted is dispatched normally.
  clickedQuery(world).forEach(eid => {
    NetworkedAnimationOnClick.playing[eid]++;
    const obj = world.eid2obj.get(eid);
    if (obj && typeof NAF !== "undefined" && localClientID) {
      NAF.connection.broadcastDataGuaranteed(NAF_DATA_TYPE, { name: obj.name });
    }
  });

  // Grabbable triggers (e.g. dragged-in models): record start time + position when held,
  // then on release decide whether the gesture was a click (animate) or a drag (skip).
  heldAnimEnterQuery(world).forEach(eid => {
    const obj = world.eid2obj.get(eid);
    if (!obj) return;
    obj.getWorldPosition(tmpPos);
    heldStartTime.set(eid, world.time.elapsed);
    heldStartPos.set(eid, tmpPos.clone());
  });

  heldAnimExitQuery(world).forEach(eid => {
    const startTime = heldStartTime.get(eid);
    const startPos = heldStartPos.get(eid);
    heldStartTime.delete(eid);
    heldStartPos.delete(eid);
    if (startTime === undefined || !startPos) return;

    const obj = world.eid2obj.get(eid);
    if (!obj) return;

    obj.getWorldPosition(tmpPos);
    const duration = world.time.elapsed - startTime;
    const distance = startPos.distanceTo(tmpPos);

    if (duration <= CLICK_DURATION_MS && distance <= CLICK_DISTANCE_M) {
      NetworkedAnimationOnClick.playing[eid]++;
      if (typeof NAF !== "undefined" && localClientID) {
        NAF.connection.broadcastDataGuaranteed(NAF_DATA_TYPE, { name: obj.name });
      }
    }
  });

  // VR hand collision check — only when in VR mode
  const inVR = APP.scene?.is("vr-mode");
  if (inVR) {
    networkedAnimQuery(world).forEach(eid => {
      const mode = triggerMode.get(eid);
      if (mode !== TriggerMode.Hand && mode !== TriggerMode.Both) return;

      const inside = isControllerInside(eid);
      const wasInside = handInside.get(eid) ?? false;

      // Trigger on entry only — require hand to leave before re-triggering
      if (inside && !wasInside) {
        NetworkedAnimationOnClick.playing[eid]++;
        const obj = world.eid2obj.get(eid);
        if (obj && typeof NAF !== "undefined" && localClientID) {
          NAF.connection.broadcastDataGuaranteed(NAF_DATA_TYPE, { name: obj.name });
        }
      }

      handInside.set(eid, inside);
    });
  }

  // Detect counter changes — triggered by local clicks, hand entry, and remote receives
  networkedAnimQuery(world).forEach(eid => {
    const current = NetworkedAnimationOnClick.playing[eid];
    if (!lastPlayCount.has(eid)) {
      // First encounter: seed without playing
      lastPlayCount.set(eid, current);
      return;
    }
    if (current !== lastPlayCount.get(eid)) {
      lastPlayCount.set(eid, current);
      playAnimations(eid);
    }
  });
}
