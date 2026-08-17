import { addComponent, defineQuery, hasComponent, removeComponent } from "bitecs";
import {
  Holdable,
  HoverButton,
  HoveredHandLeft,
  HoveredHandRight,
  HoveredRemoteLeft,
  HoveredRemoteRight,
  Interacted,
  ObjectSpawner,
  SingleActionButton,
  TextButton
} from "../bit-components";
import { BUTTON_TYPES } from "../prefabs/button3D";
import { hasAnyComponent } from "../utils/bit-utils";
import { getThemeColor, onThemeChanged } from "../utils/theme";
import { CAMERA_MODE_INSPECT } from "./camera-system";
import { paths } from "./userinput/paths";
// Which input a clickable listens to depends on what else it is. In VR the trigger emits
// `interact` and the grip emits `grab`; on desktop and touch a single button emits both.
//
// - ObjectSpawner: `grab` only. Spawning hands you the copy, so it counts as picking
//   something up and belongs on the grip. The trigger deliberately does nothing.
// - Holdable, in VR only: `interact` only. These are clickable *and* grabbable (e.g. objects
//   tagged _interactive_animation), so listening to `grab` would fire them on the very press
//   that lifts them. Outside VR one button has to do both jobs, and some Holdables can never
//   actually be held (Spoke wall buttons fail the canMove check in hold-system), so they
//   would become unclickable if `grab` stopped counting.
// - anything else: either, so bindings that only emit `grab` (desktop, touch, and the
//   headsets whose binding files predate `interact`) keep working unchanged.
function firedFor(world, eid, interacted, grabbed, inVR) {
  if (hasComponent(world, ObjectSpawner, eid)) return grabbed;
  if (inVR && hasComponent(world, Holdable, eid)) return interacted;
  return interacted || grabbed;
}
function interact(world, entities, interactPath, grabPath, interactor) {
  const userinput = AFRAME.scenes[0].systems.userinput;
  const interacted = userinput.get(interactPath);
  const grabbed = userinput.get(grabPath);
  if (!interacted && !grabbed) return;

  const inVR = AFRAME.scenes[0].is("vr-mode");
  for (let i = 0; i < entities.length; i++) {
    const eid = entities[i];
    if (!firedFor(world, eid, interacted, grabbed, inVR)) continue;
    addComponent(world, Interacted, eid);

    // TODO: New systems should not listen for this event
    // Delete this when we're done interoping with old world systems
    world.eid2obj.get(eid).dispatchEvent({
      type: "interact",
      object3D: interactor
    });
  }
}

const interactedQuery = defineQuery([Interacted]);
const rightRemoteQuery = defineQuery([SingleActionButton, HoveredRemoteRight]);
const leftRemoteQuery = defineQuery([SingleActionButton, HoveredRemoteLeft]);

function singleActionButtonSystem(world) {
  // Clear the interactions from previous frames
  const interactedEnts = interactedQuery(world);
  for (let i = 0; i < interactedEnts.length; i++) {
    const eid = interactedEnts[i];
    removeComponent(world, Interacted, eid);
  }

  if (AFRAME.scenes[0].systems["hubs-systems"].cameraSystem.mode === CAMERA_MODE_INSPECT) {
    // TODO: Fix issue where button objects are "visible" but not on the inspect layer,
    // which makes it so we can interact with them but cannot see them.
    return;
  }

  const interactorSettings = AFRAME.scenes[0].systems.interaction.options;
  interact(
    world,
    leftRemoteQuery(world),
    paths.actions.cursor.left.interact,
    paths.actions.cursor.left.grab,
    interactorSettings.leftRemote.entity.object3D
  );
  interact(
    world,
    rightRemoteQuery(world),
    paths.actions.cursor.right.interact,
    paths.actions.cursor.right.grab,
    interactorSettings.rightRemote.entity.object3D
  );
}

const buttonStyles = {};
// TODO these colors come from what we are doing in theme.js for aframe mixins but they seem fishy
function applyTheme() {
  buttonStyles[BUTTON_TYPES.DEFAULT] = {
    color: new THREE.Color(0xffffff),
    hoverColor: new THREE.Color(0xaaaaaa),
    textColor: new THREE.Color(getThemeColor("action-color")),
    textHoverColor: new THREE.Color(getThemeColor("action-color-highlight"))
  };
  buttonStyles[BUTTON_TYPES.ACTION] = {
    color: new THREE.Color(getThemeColor("action-color")),
    hoverColor: new THREE.Color(getThemeColor("action-color-highlight")),
    textColor: new THREE.Color(0xffffff),
    textHoverColor: new THREE.Color(0xffffff)
  };
}
onThemeChanged(applyTheme);
applyTheme();

const hoverComponents = [HoveredRemoteRight, HoveredRemoteLeft, HoveredHandRight, HoveredHandLeft];

const hoverButtonsQuery = defineQuery([HoverButton]);
function hoverButtonSystem(world) {
  hoverButtonsQuery(world).forEach(function (eid) {
    const obj = world.eid2obj.get(eid);
    const isHovered = hasAnyComponent(world, hoverComponents, eid);
    const style = buttonStyles[HoverButton.type[eid]];
    obj.material.color.copy(isHovered ? style.hoverColor : style.color);
    if (hasComponent(world, TextButton, eid)) {
      const lbl = world.eid2obj.get(TextButton.labelRef[eid]);
      lbl.color = isHovered ? style.textHoverColor : style.textColor;
    }
  });
}

export function buttonSystems(world) {
  hoverButtonSystem(world);
  singleActionButtonSystem(world);
}
