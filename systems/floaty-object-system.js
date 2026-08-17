import { COLLISION_LAYERS } from "../constants";
import {
  enterQuery,
  addComponent,
  removeComponent,
  defineComponent,
  defineQuery,
  exitQuery,
  hasComponent,
  Not,
  entityExists
} from "bitecs";
import {
  FloatyObject,
  Owned,
  Rigidbody,
  MakeKinematicOnRelease,
  Constraint,
  NetworkedFloatyObject
} from "../bit-components";
import { Vector3 } from "three";
import { setMatrixWorld } from "../utils/three-utils";

export const MakeStaticWhenAtRest = defineComponent();

const makeStaticAtRestQuery = defineQuery([FloatyObject, Rigidbody, Not(Constraint), MakeStaticWhenAtRest]);
function makeStaticAtRest(world) {
  const physicsSystem = AFRAME.scenes[0].systems["hubs-systems"].physicsSystem;
  makeStaticAtRestQuery(world).forEach(eid => {
    const isMine = hasComponent(world, Owned, eid);
    if (!isMine) {
      removeComponent(world, MakeStaticWhenAtRest, eid);
      return;
    }

    const bodyId = Rigidbody.bodyId[eid];
    const bodyData = physicsSystem.bodyUuidToData.get(bodyId);
    const isAtRest =
      physicsSystem.bodyInitialized(bodyId) &&
      physicsSystem.getLinearVelocity(bodyId) < bodyData.options.linearSleepingThreshold &&
      physicsSystem.getAngularVelocity(bodyId) < bodyData.options.angularSleepingThreshold;

    if (isAtRest) {
      Object.assign(bodyData.options, {
        type: "kinematic"
      });
      physicsSystem.updateRigidBody(eid, bodyData.options);
      removeComponent(world, MakeStaticWhenAtRest, eid);
    }
  });
}

const makeKinematicOnReleaseExitQuery = exitQuery(defineQuery([Rigidbody, Constraint, MakeKinematicOnRelease]));
function makeKinematicOnRelease(world) {
  const physicsSystem = AFRAME.scenes[0].systems["hubs-systems"].physicsSystem;
  makeKinematicOnReleaseExitQuery(world).forEach(eid => {
    if (!entityExists(world, eid) || !hasComponent(world, Owned, eid)) return;
    // DEBUG
    //console.log("makeKinematicOnRelease firing — about to set kinematic");
    physicsSystem.updateRigidBodyOptions(eid, { type: "kinematic" });
  });
}
// Release speed (m/s) at or above which a release counts as a throw rather than a placement.
// Below it the object gets heavy damping and settles where it was let go; at or above it the
// object keeps its momentum and floats away under the reduced release gravity.
// Measured in VR: a deliberate gentle placement reads ~0.6, the hardest achievable throw ~1.6,
// so this sits between the two. Raise it if placements start flying, lower it if throws stick.
const THROW_VELOCITY_THRESHOLD = 1.0;

export const FLOATY_OBJECT_FLAGS = {
  MODIFY_GRAVITY_ON_RELEASE: 1 << 0,
  REDUCE_ANGULAR_FLOAT: 1 << 1,
  UNTHROWABLE: 1 << 2,
  HELIUM_WHEN_LARGE: 1 << 3
};
// --- Floor fall-through safety net -------------------------------------------------
// Objects (mainly in VR, where release/throw velocities are far higher than a desktop
// drop) occasionally tunnel through a thin floor collider before physics can resolve the
// collision. This is a band-aid: we remember where each object was dropped and, if it
// later ends up well below that point, snap it back and pin it so it stops falling. It
// does not fix the underlying tunneling — it just prevents objects from being lost.
const FALL_THROUGH_LIMIT = 6; // metres below the drop height before we treat it as "fell through the floor"
const dropMatrices = new Map();
const _recoverPos = new Vector3();

function recordDropPose(world, eid) {
  const obj = world.eid2obj.get(eid);
  if (!obj) return;
  obj.updateMatrices();
  dropMatrices.set(eid, obj.matrixWorld.clone());
}

function recoverFallenObjects(world, physicsSystem) {
  dropMatrices.forEach((dropMatrix, eid) => {
    if (!entityExists(world, eid) || !hasComponent(world, Owned, eid) || !hasComponent(world, Rigidbody, eid)) {
      dropMatrices.delete(eid);
      return;
    }

    const bodyId = Rigidbody.bodyId[eid];
    const bodyData = physicsSystem.bodyUuidToData.get(bodyId);
    // Only dynamic bodies fall. Once something is held/kinematic/at-rest there is nothing
    // to recover, so stop watching it.
    if (!bodyData || bodyData.options.type !== "dynamic") {
      dropMatrices.delete(eid);
      return;
    }

    const obj = world.eid2obj.get(eid);
    obj.updateMatrices();
    _recoverPos.setFromMatrixPosition(obj.matrixWorld);
    const dropY = dropMatrix.elements[13];
    if (_recoverPos.y < dropY - FALL_THROUGH_LIMIT) {
      // Almost certainly tunneled through the floor. Snap it back to where it was dropped
      // and pin it (kinematic) — the same state makeStaticAtRest uses — so it stops falling
      // and can simply be grabbed again.
      setMatrixWorld(obj, dropMatrix);
      physicsSystem.updateRigidBodyOptions(eid, { type: "kinematic" });
      dropMatrices.delete(eid);
      console.warn(`[floor-recovery] Object eid=${eid} fell below its drop point; snapped back and pinned.`);
    }
  });
}
// -----------------------------------------------------------------------------------

const enteredFloatyObjectsQuery = enterQuery(defineQuery([FloatyObject, Rigidbody]));
const heldFloatyObjectsQuery = defineQuery([FloatyObject, Rigidbody, Constraint]);
const exitedHeldFloatyObjectsQuery = exitQuery(heldFloatyObjectsQuery);
const enterHeldFloatyObjectsQuery = enterQuery(heldFloatyObjectsQuery);
const networkedFloatyObjectsQuery = defineQuery([FloatyObject, NetworkedFloatyObject]);
export const floatyObjectSystem = world => {
  const physicsSystem = AFRAME.scenes[0].systems["hubs-systems"].physicsSystem;

  enteredFloatyObjectsQuery(world).forEach(eid => {
    physicsSystem.updateRigidBodyOptions(eid, {
      type: "kinematic",
      gravity: { x: 0, y: 0, z: 0 }
    });
  });

  enterHeldFloatyObjectsQuery(world).forEach(eid => {
    physicsSystem.updateRigidBodyOptions(eid, {
      gravity: { x: 0, y: 0, z: 0 },
      type: "dynamic",
      collisionFilterMask: COLLISION_LAYERS.HANDS | COLLISION_LAYERS.MEDIA_FRAMES
    });
    // DEBUG
    //console.log("enterHeld fired, type now:", physicsSystem.bodyUuidToData.get(Rigidbody.bodyId[eid]).options.type);
  });

  exitedHeldFloatyObjectsQuery(world).forEach(eid => {
    if (!entityExists(world, eid) || !(hasComponent(world, FloatyObject, eid) && hasComponent(world, Rigidbody, eid)))
      return;

    // Remember where it was released so the fall-through safety net can snap it back.
    recordDropPose(world, eid);
    const bodyId = Rigidbody.bodyId[eid];
    const bodyData = physicsSystem.bodyUuidToData.get(bodyId);

    if (FloatyObject.flags[eid] & FLOATY_OBJECT_FLAGS.MODIFY_GRAVITY_ON_RELEASE) {
      if (bodyData.linearVelocity < THROW_VELOCITY_THRESHOLD) {
        physicsSystem.updateRigidBodyOptions(eid, {
          // Explicitly restore the dynamic type: the cached body options can still carry the
          // "static" default from the bitECS Rigidbody store, and a static body ignores
          // gravity entirely, so the object just freezes wherever it was released.
          type: "dynamic",
          gravity: { x: 0, y: 0, z: 0 },
          angularDamping: FloatyObject.flags[eid] & FLOATY_OBJECT_FLAGS.REDUCE_ANGULAR_FLOAT ? 0.89 : 0.5,
          linearDamping: 0.95,
          linearSleepingThreshold: 0.1,
          angularSleepingThreshold: 0.1,
          collisionFilterMask: COLLISION_LAYERS.HANDS | COLLISION_LAYERS.MEDIA_FRAMES
        });
        addComponent(world, MakeStaticWhenAtRest, eid);
      } else {
        physicsSystem.updateRigidBodyOptions(eid, {
          // See above — without this the thrown object stays static and never flies.
          type: "dynamic",
          gravity: { x: 0, y: FloatyObject.releaseGravity[eid], z: 0 },
          angularDamping: 0.01,
          linearDamping: 0.01,
          linearSleepingThreshold: 1.6,
          angularSleepingThreshold: 2.5,
          collisionFilterMask: COLLISION_LAYERS.DEFAULT_INTERACTABLE
        });
        // A body that was static has no activation state to speak of, so make sure it is
        // awake — otherwise the new gravity would not be applied and it would hang in place.
        physicsSystem.activateBody(bodyId);
        removeComponent(world, MakeStaticWhenAtRest, eid);
      }
    } else if (FloatyObject.flags[eid] & FLOATY_OBJECT_FLAGS.HELIUM_WHEN_LARGE) {
      const curScale = world.eid2obj.get(eid).scale.x;

      // These three hard-coded values may need to become a property of the FloatyObject
      // component if HELIUM_WHEN_LARGE is used for an entity other than the Duck
      const initialScale = 1;
      const maxScale = 5.0;
      const maxForce = 6.5;

      const ratio = Math.min(1, (curScale - initialScale) / (maxScale - initialScale));
      const force = ratio * maxForce;

      if (force > 0) {
        const angle = Math.random() * Math.PI * 2;
        const x = Math.cos(angle);
        const z = Math.sin(angle);
        physicsSystem.updateRigidBodyOptions(eid, {
          gravity: { x, y: force, z },
          angularDamping: 0.01,
          linearDamping: 0.01,
          linearSleepingThreshold: 1.6,
          angularSleepingThreshold: 2.5,
          collisionFilterMask: COLLISION_LAYERS.DEFAULT_INTERACTABLE
        });
        removeComponent(world, MakeStaticWhenAtRest, eid);
      }
    } else {
      // Ensure the physics type is dynamic, otherwise the object won't be affected by physics and drop
      physicsSystem.updateRigidBodyOptions(eid, {
        type: "dynamic",
        collisionFilterMask: COLLISION_LAYERS.DEFAULT_INTERACTABLE,
        gravity: { x: 0, y: -9.8, z: 0 }
      });
      // Wake the body — after settling on the floor following a drop, it auto-sleeps
      // and a low-velocity cursor release isn't enough to reactivate it, so gravity
      // wouldn't apply and the object would float in place.
      // DEBUG
      //console.log("Activate body. Type:", bodyData.options.type, "gravity:", bodyData.options.gravity);
      physicsSystem.activateBody(bodyId);
    }
  });

  networkedFloatyObjectsQuery(world).forEach(eid => {
    if (hasComponent(world, Owned, eid)) {
      NetworkedFloatyObject.flags[eid] = FloatyObject.flags[eid];
    } else {
      FloatyObject.flags[eid] = NetworkedFloatyObject.flags[eid];
    }
  });

  makeStaticAtRest(world);
  makeKinematicOnRelease(world);
  recoverFallenObjects(world, physicsSystem);
};
