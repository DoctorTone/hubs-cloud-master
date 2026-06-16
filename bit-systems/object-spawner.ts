import { addComponent, defineQuery, enterQuery, exitQuery } from "bitecs";
import { Box3, Matrix4, Quaternion, Vector3 } from "three";
import { HubsWorld } from "../app";
import { FloatyObject, Held, HeldRemoteRight, Interacted, ObjectSpawner } from "../bit-components";
import { FLOATY_OBJECT_FLAGS } from "../systems/floaty-object-system";
import { computeObjectAABB } from "../utils/auto-box-collider";
import { coroutine } from "../utils/coroutine";
import { createNetworkedMedia } from "../utils/create-networked-entity";
import { EntityID } from "../utils/networking-types";
import { setMatrixWorld } from "../utils/three-utils";
import { animateScale } from "./media-loading";
import { sleep } from "../utils/async-utils";

export enum OBJECT_SPAWNER_FLAGS {
  /** Apply gravity to spawned objects */
  APPLY_GRAVITY = 1 << 0
}

function* spawnObjectJob(world: HubsWorld, spawner: EntityID) {
  if (!APP.hubChannel!.can("spawn_and_move_media")) return;

  // If the Spoke node is named "Spawner_<object_name>", spawned copies inherit
  // <object_name>. This lets naming conventions like _interactive_animation flow
  // through the spawner without re-authoring the underlying GLB.
  const spawnerObj = world.eid2obj.get(spawner);
  let displayName: string | undefined;
  if (spawnerObj?.name?.startsWith("Spawner_")) {
    const suffix = spawnerObj.name.substring("Spawner_".length);
    if (suffix) displayName = suffix;
  }

  const spawned = createNetworkedMedia(world, {
    src: APP.getString(ObjectSpawner.src[spawner])!,
    recenter: false,
    resize: false,
    animateLoad: false,
    isObjectMenuTarget: true,
    displayName
  });

  if (ObjectSpawner.flags[spawner] & OBJECT_SPAWNER_FLAGS.APPLY_GRAVITY) {
    FloatyObject.flags[spawned] &= ~FLOATY_OBJECT_FLAGS.MODIFY_GRAVITY_ON_RELEASE;
  }

  addComponent(world, HeldRemoteRight, spawned);
  addComponent(world, Held, spawned);

  spawnerObj!.updateMatrices();
  const spawnedObj = world.eid2obj.get(spawned)!;
  setMatrixWorld(spawnedObj, spawnerObj!.matrixWorld);

  // Nudge the spawned copy horizontally, toward the player, so it doesn't materialize
  // buried inside the spawner (where it looks like nothing happened). We offset
  // *sideways* rather than upward on purpose: spawning above the floor leaves the copy
  // hanging in the air (no-gravity floaty objects) or settling to a bad anchor height,
  // so keeping its Y at the spawner's value lets it appear already resting on the floor.
  // The copy inherits the spawner's matrix (incl. scale), so the spawner's AABB is a good
  // proxy for the copy's size; offsetting by the full horizontal extent fully clears the
  // (same-size) spawner. This runs before the cursor constraint forms, so the gap rides
  // along under the cursor.
  const box = new Box3();
  computeObjectAABB(spawnerObj!, box, true);
  if (!box.isEmpty()) {
    const size = new Vector3();
    box.getSize(size);
    const clearance = Math.max(size.x, size.z) * 0.5;

    const m = new Matrix4().copy(spawnedObj.matrixWorld);
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    m.decompose(position, quaternion, scale);

    // Horizontal direction from the spawner toward the player's camera.
    const dir = new Vector3();
    AFRAME.scenes[0].systems["hubs-systems"].cameraSystem.viewingCamera.getWorldPosition(dir);
    dir.sub(position);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) {
      // Camera is directly above/below the spawner; fall back to a fixed horizontal axis.
      dir.set(0, 0, 1);
    }
    dir.normalize();

    position.addScaledVector(dir, clearance);
    m.compose(position, quaternion, scale);
    setMatrixWorld(spawnedObj, m);
  }

  yield sleep(100);
  yield* animateScale(world, spawner);
}

// TODO type for coroutine
type Coroutine = () => IteratorResult<undefined, any>;
const jobs = new Map<EntityID, Coroutine>();

const interactedSpawnersEnterQuery = enterQuery(defineQuery([ObjectSpawner, Interacted]));
const spawnerExitQuery = exitQuery(defineQuery([ObjectSpawner]));
export function objectSpawnerSystem(world: HubsWorld) {
  interactedSpawnersEnterQuery(world).forEach(spawner => {
    if (!jobs.has(spawner)) jobs.set(spawner, coroutine(spawnObjectJob(world, spawner)));
  });
  spawnerExitQuery(world).forEach(function (spawner) {
    jobs.delete(spawner);
  });
  jobs.forEach((job, spawner) => {
    if (job().done) jobs.delete(spawner);
  });
}
