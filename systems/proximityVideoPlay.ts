import { addComponent, defineQuery, enterQuery, exitQuery } from "bitecs";
import { Vector3 } from "three";
import { HubsWorld } from "../app";
import { MediaLoader, MediaVideoData, NetworkedProximityVideo, Object3DTag, ProximityVideo } from "../bit-components";
import { localClientID } from "../bit-systems/networking";

const DISTANCES = { near: 2, medium: 5, far: 10 }; // metres
const PROXIMITY_TOKENS: Record<string, number> = {
  _video_proximity_near: DISTANCES.near,
  _video_proximity_medium: DISTANCES.medium,
  _video_proximity_far: DISTANCES.far
};
const NAF_DATA_TYPE = "proximity-video-play";

const nameToEid = new Map<number, string>();
const wasInRange = new Map<number, boolean>();
const primed = new Map<number, boolean>();
const inRangeFrames = new Map<number, number>();
const lastEnterCount = new Map<number, number>();
const lastLeaveCount = new Map<number, number>();
const nameToEidLookup = new Map<string, number>();
const pendingInitialPause = new Set<number>();
const DEBOUNCE_FRAMES = 10;

let nafHandlerRegistered = false;

const newObjectQuery = enterQuery(defineQuery([Object3DTag]));
const proxVideoQuery = defineQuery([ProximityVideo, NetworkedProximityVideo]);
const proxVideoEnterQuery = enterQuery(proxVideoQuery);
const proxVideoExitQuery = exitQuery(proxVideoQuery);

const listenerPos = new Vector3();
const objPos = new Vector3();

function ensureNafHandler() {
  if (nafHandlerRegistered) return;
  nafHandlerRegistered = true;
  NAF.connection.subscribeToDataChannel(
    NAF_DATA_TYPE,
    (_senderId: string, _dataType: string, data: { name: string; action: "enter" | "leave" }) => {
      const eid = nameToEidLookup.get(data.name);
      if (eid !== undefined) {
        if (data.action === "enter") {
          NetworkedProximityVideo.entering[eid]++;
        } else {
          NetworkedProximityVideo.leaving[eid]++;
        }
      }
    }
  );
}

function findVideoElement(world: HubsWorld, eid: number): HTMLVideoElement | null {
  // 1. Check bitECS MediaVideoData on this entity and its mediaRef
  const video = MediaVideoData.get(eid);
  if (video) return video;
  const mediaRef = MediaLoader.mediaRef[eid];
  if (mediaRef) {
    const v = MediaVideoData.get(mediaRef);
    if (v) return v;
  }

  // 2. Check the legacy A-Frame media-video component on this entity and descendants
  const obj = world.eid2obj.get(eid);
  if (!obj) return null;

  let found: HTMLVideoElement | null = null;
  obj.traverse(child => {
    if (found) return;
    const el = (child as any).el;
    if (el?.components?.["media-video"]?.video) {
      found = el.components["media-video"].video;
    }
  });
  return found;
}

function handleEnter(world: HubsWorld, eid: number) {
  const video = findVideoElement(world, eid);
  if (!video) return;
  video.loop = true;
  video.play().catch(() => {
    console.error("Proximity video: play() failed (user may not have interacted with page yet).");
  });
}

function handleLeave(world: HubsWorld, eid: number) {
  const video = findVideoElement(world, eid);
  if (!video) return;
  video.pause();
}

export function proximityVideoPlaySystem(world: HubsWorld) {
  if (typeof NAF !== "undefined" && localClientID) {
    ensureNafHandler();
  }

  // Tag any object whose name contains a proximity video token
  newObjectQuery(world).forEach(eid => {
    const obj = world.eid2obj.get(eid);
    if (!obj) return;
    for (const [token, distance] of Object.entries(PROXIMITY_TOKENS)) {
      if (obj.name.includes(token)) {
        addComponent(world, ProximityVideo, eid);
        addComponent(world, NetworkedProximityVideo, eid);
        ProximityVideo.threshold[eid] = distance;
        nameToEid.set(eid, obj.name);
        nameToEidLookup.set(obj.name, eid);
        break;
      }
    }
  });

  // Initialise newly tagged entities
  proxVideoEnterQuery(world).forEach(eid => {
    lastEnterCount.set(eid, NetworkedProximityVideo.entering[eid]);
    lastLeaveCount.set(eid, NetworkedProximityVideo.leaving[eid]);
    wasInRange.set(eid, false);
    primed.set(eid, false);
    inRangeFrames.set(eid, 0);

    // The video loads asynchronously so it is likely not available yet.
    // Add to pending set so we can pause it once it becomes available.
    const video = findVideoElement(world, eid);
    if (video) {
      video.pause();
    } else {
      pendingInitialPause.add(eid);
    }
  });

  // Retry pausing videos that weren't ready when the entity was first tagged
  if (pendingInitialPause.size > 0) {
    for (const eid of pendingInitialPause) {
      const video = findVideoElement(world, eid);
      if (video) {
        video.pause();
        pendingInitialPause.delete(eid);
      }
    }
  }

  // Clean up removed entities
  proxVideoExitQuery(world).forEach(eid => {
    const name = nameToEid.get(eid);
    if (name) nameToEidLookup.delete(name);
    nameToEid.delete(eid);
    wasInRange.delete(eid);
    primed.delete(eid);
    inRangeFrames.delete(eid);
    lastEnterCount.delete(eid);
    lastLeaveCount.delete(eid);
    pendingInitialPause.delete(eid);
  });

  // Per-frame proximity check
  APP.audioListener.getWorldPosition(listenerPos);
  proxVideoQuery(world).forEach(eid => {
    const obj = world.eid2obj.get(eid);
    if (!obj) return;

    const thresholdSq = ProximityVideo.threshold[eid] ** 2;
    obj.getWorldPosition(objPos);
    const distSq = listenerPos.distanceToSquared(objPos);
    const inRange = distSq < thresholdSq;

    if (!inRange) {
      primed.set(eid, true);
      inRangeFrames.set(eid, 0);
    } else {
      inRangeFrames.set(eid, (inRangeFrames.get(eid) ?? 0) + 1);
    }

    const stableInRange = inRange && (inRangeFrames.get(eid) ?? 0) >= DEBOUNCE_FRAMES;

    // Detect entering proximity
    if (stableInRange && primed.get(eid) && !wasInRange.get(eid)) {
      NetworkedProximityVideo.entering[eid]++;
      if (typeof NAF !== "undefined" && localClientID) {
        const name = nameToEid.get(eid);
        if (name) NAF.connection.broadcastDataGuaranteed(NAF_DATA_TYPE, { name, action: "enter" });
      }
    }

    // Detect leaving proximity
    if (!stableInRange && wasInRange.get(eid)) {
      NetworkedProximityVideo.leaving[eid]++;
      if (typeof NAF !== "undefined" && localClientID) {
        const name = nameToEid.get(eid);
        if (name) NAF.connection.broadcastDataGuaranteed(NAF_DATA_TYPE, { name, action: "leave" });
      }
    }

    wasInRange.set(eid, stableInRange);
  });

  // Detect counter changes — triggered by local proximity and remote receives
  proxVideoQuery(world).forEach(eid => {
    const currentEnter = NetworkedProximityVideo.entering[eid];
    const currentLeave = NetworkedProximityVideo.leaving[eid];

    if (!lastEnterCount.has(eid)) {
      lastEnterCount.set(eid, currentEnter);
      lastLeaveCount.set(eid, currentLeave);
      return;
    }

    if (currentEnter !== lastEnterCount.get(eid)) {
      lastEnterCount.set(eid, currentEnter);
      handleEnter(world, eid);
    }

    if (currentLeave !== lastLeaveCount.get(eid)) {
      lastLeaveCount.set(eid, currentLeave);
      handleLeave(world, eid);
    }
  });
}
