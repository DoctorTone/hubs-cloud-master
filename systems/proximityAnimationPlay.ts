import { addComponent, defineQuery, enterQuery, exitQuery } from "bitecs";
import { AnimationAction, AnimationMixer, LoopOnce, Object3D, Vector3 } from "three";
import { HubsWorld } from "../app";
import { MixerAnimatableData, NetworkedProximityAnimation, Object3DTag, ProximityAnimation } from "../bit-components";
import { localClientID } from "../bit-systems/networking";

const DISTANCES = { near: 2, medium: 5, far: 10 }; // metres
const PROXIMITY_TOKENS: Record<string, number> = {
  _proximity_near: DISTANCES.near,
  _proximity_medium: DISTANCES.medium,
  _proximity_far: DISTANCES.far
};
const NAF_DATA_TYPE = "proximity-animation-play";

const mixers = new Map<number, AnimationMixer>();
const animRoots = new Map<number, Object3D>();
const triggerUUIDs = new Map<number, Set<string>>();
const lastEnterCount = new Map<number, number>();
const lastLeaveCount = new Map<number, number>();
const nameToEid = new Map<string, number>();
const wasInRange = new Map<number, boolean>();
const primed = new Map<number, boolean>();
const inRangeFrames = new Map<number, number>();
const activeActions = new Map<number, AnimationAction[]>();
const DEBOUNCE_FRAMES = 10; // consecutive in-range frames before triggering

let nafHandlerRegistered = false;

const newObjectQuery = enterQuery(defineQuery([Object3DTag]));
const animQuery = defineQuery([ProximityAnimation, NetworkedProximityAnimation]);
const animEnterQuery = enterQuery(animQuery);
const animExitQuery = exitQuery(animQuery);
const networkedAnimQuery = defineQuery([ProximityAnimation, NetworkedProximityAnimation]);

const listenerPos = new Vector3();
const objPos = new Vector3();

function ensureNafHandler() {
  if (nafHandlerRegistered) return;
  nafHandlerRegistered = true;
  NAF.connection.subscribeToDataChannel(
    NAF_DATA_TYPE,
    (_senderId: string, _dataType: string, data: { name: string; action: "enter" | "leave" }) => {
      const eid = nameToEid.get(data.name);
      if (eid !== undefined) {
        if (data.action === "enter") {
          NetworkedProximityAnimation.entering[eid]++;
        } else {
          NetworkedProximityAnimation.leaving[eid]++;
        }
      }
    }
  );
}

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

function getMyClips(eid: number) {
  const root = animRoots.get(eid);
  const uuids = triggerUUIDs.get(eid);
  if (!root || !uuids) return [];
  return root.animations.filter(clip => clip.tracks.some(track => uuids.has(track.name.split(".")[0])));
}

function handleEnter(eid: number) {
  const mixer = mixers.get(eid);
  if (!mixer) return;

  const myClips = getMyClips(eid);
  if (myClips.length === 0) return;

  if (myClips.length === 1) {
    // 1 animation: loop continuously, unpause if already running
    const clip = myClips[0];
    const action = mixer.clipAction(clip);
    if (action.paused) {
      action.paused = false;
    } else {
      mixer.stopAllAction();
      action.reset();
      action.play();
    }
    activeActions.set(eid, [action]);
  } else {
    // 2+ animations: play the first animation once on enter
    mixer.stopAllAction();
    const clip = myClips[0];
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    activeActions.set(eid, [action]);
  }
}

function handleLeave(eid: number) {
  const mixer = mixers.get(eid);
  if (!mixer) return;

  const myClips = getMyClips(eid);
  if (myClips.length === 0) return;

  if (myClips.length >= 2) {
    // 2+ animations: play the second animation on leave
    mixer.stopAllAction();
    const clip = myClips[1];
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    activeActions.set(eid, [action]);
  } else {
    // 1 animation: pause it where it is
    const actions = activeActions.get(eid);
    if (actions) {
      for (const action of actions) {
        action.paused = true;
      }
    }
  }
}

export function proximityAnimationPlaySystem(world: HubsWorld) {
  if (typeof NAF !== "undefined" && localClientID) {
    ensureNafHandler();
  }

  // Tag any object whose name contains a proximity token
  newObjectQuery(world).forEach(eid => {
    const obj = world.eid2obj.get(eid);
    if (!obj) return;
    for (const [token, distance] of Object.entries(PROXIMITY_TOKENS)) {
      if (obj.name.includes(token)) {
        addComponent(world, ProximityAnimation, eid);
        addComponent(world, NetworkedProximityAnimation, eid);
        ProximityAnimation.threshold[eid] = distance;
        nameToEid.set(obj.name, eid);
        break;
      }
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
    lastEnterCount.set(eid, NetworkedProximityAnimation.entering[eid]);
    lastLeaveCount.set(eid, NetworkedProximityAnimation.leaving[eid]);

    wasInRange.set(eid, false);
    // Don't allow triggers until the user has been observed OUT of range at least once.
    // This prevents false triggers from position jumps (e.g. "Enter Room" teleport).
    primed.set(eid, false);
    inRangeFrames.set(eid, 0);

    // Stop auto-play only for clips belonging to this entity, leaving other
    // animations (e.g. Spoke auto-animate objects) on the shared mixer untouched.
    stopClipsForEntity(ctx, uuids, obj);
  });

  // Clean up when entity is removed
  animExitQuery(world).forEach(eid => {
    const obj = world.eid2obj.get(eid);
    if (obj) nameToEid.delete(obj.name);
    mixers.get(eid)?.stopAllAction();
    mixers.delete(eid);
    animRoots.delete(eid);
    triggerUUIDs.delete(eid);
    lastEnterCount.delete(eid);
    lastLeaveCount.delete(eid);
    wasInRange.delete(eid);
    primed.delete(eid);
    inRangeFrames.delete(eid);
    activeActions.delete(eid);
  });

  // Advance all active mixers
  animQuery(world).forEach(eid => {
    mixers.get(eid)?.update(world.time.delta / 1000.0);
  });

  // Per-frame proximity check using squared distance to avoid sqrt
  APP.audioListener.getWorldPosition(listenerPos);
  networkedAnimQuery(world).forEach(eid => {
    const obj = world.eid2obj.get(eid);
    if (!obj) return;

    const thresholdSq = ProximityAnimation.threshold[eid] ** 2;
    obj.getWorldPosition(objPos);
    const distSq = listenerPos.distanceToSquared(objPos);
    const inRange = distSq < thresholdSq;

    // Only arm the trigger once the user has been seen outside the zone
    if (!inRange) {
      primed.set(eid, true);
      inRangeFrames.set(eid, 0);
    } else {
      inRangeFrames.set(eid, (inRangeFrames.get(eid) ?? 0) + 1);
    }

    // Require DEBOUNCE_FRAMES consecutive in-range frames to filter out
    // transient position glitches (e.g. listener jumping to origin on room enter)
    const stableInRange = inRange && (inRangeFrames.get(eid) ?? 0) >= DEBOUNCE_FRAMES;

    // Detect entering proximity
    if (stableInRange && primed.get(eid) && !wasInRange.get(eid)) {
      NetworkedProximityAnimation.entering[eid]++;
      if (typeof NAF !== "undefined" && localClientID) {
        NAF.connection.broadcastDataGuaranteed(NAF_DATA_TYPE, { name: obj.name, action: "enter" });
      }
    }

    // Detect leaving proximity
    if (!stableInRange && wasInRange.get(eid)) {
      NetworkedProximityAnimation.leaving[eid]++;
      if (typeof NAF !== "undefined" && localClientID) {
        NAF.connection.broadcastDataGuaranteed(NAF_DATA_TYPE, { name: obj.name, action: "leave" });
      }
    }

    wasInRange.set(eid, stableInRange);
  });

  // Detect counter changes — triggered by local proximity and remote receives
  networkedAnimQuery(world).forEach(eid => {
    const currentEnter = NetworkedProximityAnimation.entering[eid];
    const currentLeave = NetworkedProximityAnimation.leaving[eid];

    if (!lastEnterCount.has(eid)) {
      lastEnterCount.set(eid, currentEnter);
      lastLeaveCount.set(eid, currentLeave);
      return;
    }

    if (currentEnter !== lastEnterCount.get(eid)) {
      lastEnterCount.set(eid, currentEnter);
      handleEnter(eid);
    }

    if (currentLeave !== lastLeaveCount.get(eid)) {
      lastLeaveCount.set(eid, currentLeave);
      handleLeave(eid);
    }
  });
}
