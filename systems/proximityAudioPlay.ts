import { addComponent, defineQuery, enterQuery, exitQuery } from "bitecs";
import { Vector3 } from "three";
import { HubsWorld } from "../app";
import { MediaLoader, MediaVideoData, NetworkedProximityAudio, Object3DTag, ProximityAudio } from "../bit-components";
import { localClientID } from "../bit-systems/networking";

const DISTANCES = { near: 2, medium: 5, far: 10 }; // metres
const PROXIMITY_TOKENS: Record<string, number> = {
  _audio_proximity_near: DISTANCES.near,
  _audio_proximity_medium: DISTANCES.medium,
  _audio_proximity_far: DISTANCES.far
};
const NAF_DATA_TYPE = "proximity-audio-play";

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
const proxAudioQuery = defineQuery([ProximityAudio, NetworkedProximityAudio]);
const proxAudioEnterQuery = enterQuery(proxAudioQuery);
const proxAudioExitQuery = exitQuery(proxAudioQuery);

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
          NetworkedProximityAudio.entering[eid]++;
        } else {
          NetworkedProximityAudio.leaving[eid]++;
        }
      }
    }
  );
}

function findAudioElement(world: HubsWorld, eid: number): HTMLVideoElement | null {
  // Audio files in Hubs are handled via the same media-video component as video,
  // using an HTMLVideoElement (or HTMLAudioElement) under the hood.

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
  const audio = findAudioElement(world, eid);
  if (!audio) return;
  audio.loop = false;
  audio.play().catch(() => {
    console.error("Proximity audio: play() failed (user may not have interacted with page yet).");
  });
}

function handleLeave(world: HubsWorld, eid: number) {
  const audio = findAudioElement(world, eid);
  if (!audio) return;
  audio.pause();
}

export function proximityAudioPlaySystem(world: HubsWorld) {
  if (typeof NAF !== "undefined" && localClientID) {
    ensureNafHandler();
  }

  // Tag any object whose name contains a proximity audio token
  newObjectQuery(world).forEach(eid => {
    const obj = world.eid2obj.get(eid);
    if (!obj) return;
    for (const [token, distance] of Object.entries(PROXIMITY_TOKENS)) {
      if (obj.name.includes(token)) {
        addComponent(world, ProximityAudio, eid);
        addComponent(world, NetworkedProximityAudio, eid);
        ProximityAudio.threshold[eid] = distance;
        nameToEid.set(eid, obj.name);
        nameToEidLookup.set(obj.name, eid);
        break;
      }
    }
  });

  // Initialise newly tagged entities
  proxAudioEnterQuery(world).forEach(eid => {
    lastEnterCount.set(eid, NetworkedProximityAudio.entering[eid]);
    lastLeaveCount.set(eid, NetworkedProximityAudio.leaving[eid]);
    wasInRange.set(eid, false);
    primed.set(eid, false);
    inRangeFrames.set(eid, 0);

    const audio = findAudioElement(world, eid);
    if (audio) {
      audio.pause();
    } else {
      pendingInitialPause.add(eid);
    }
  });

  // Retry pausing audio that wasn't ready when the entity was first tagged
  if (pendingInitialPause.size > 0) {
    for (const eid of pendingInitialPause) {
      const audio = findAudioElement(world, eid);
      if (audio) {
        audio.pause();
        pendingInitialPause.delete(eid);
      }
    }
  }

  // Clean up removed entities
  proxAudioExitQuery(world).forEach(eid => {
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
  proxAudioQuery(world).forEach(eid => {
    const obj = world.eid2obj.get(eid);
    if (!obj) return;

    const thresholdSq = ProximityAudio.threshold[eid] ** 2;
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
      NetworkedProximityAudio.entering[eid]++;
      if (typeof NAF !== "undefined" && localClientID) {
        const name = nameToEid.get(eid);
        if (name) NAF.connection.broadcastDataGuaranteed(NAF_DATA_TYPE, { name, action: "enter" });
      }
    }

    // Detect leaving proximity
    if (!stableInRange && wasInRange.get(eid)) {
      NetworkedProximityAudio.leaving[eid]++;
      if (typeof NAF !== "undefined" && localClientID) {
        const name = nameToEid.get(eid);
        if (name) NAF.connection.broadcastDataGuaranteed(NAF_DATA_TYPE, { name, action: "leave" });
      }
    }

    wasInRange.set(eid, stableInRange);
  });

  // Detect counter changes — triggered by local proximity and remote receives
  proxAudioQuery(world).forEach(eid => {
    const currentEnter = NetworkedProximityAudio.entering[eid];
    const currentLeave = NetworkedProximityAudio.leaving[eid];

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
