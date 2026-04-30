import { addComponent, addEntity, defineQuery, enterQuery } from "bitecs";
import { BoxGeometry, Mesh, MeshStandardMaterial } from "three";
import { addObject3DComponent } from "../utils/jsx-entity";
import { HubsWorld } from "../app";
import { CursorRaycastable, RemoteHoverTarget, SingleActionButton, Interacted } from "../bit-components";

let myEid = -1;

const SPIN_DURATION = 2000;
let spin: { startTime: number; startY: number } | null = null;

const clickedQuery = enterQuery(defineQuery([SingleActionButton, Interacted]));

export function transformToggleSystem(world: HubsWorld) {
  if (myEid === -1) {
    myEid = addEntity(world);
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: "grey" }));
    mesh.position.set(-3, 1.5, 0);
    addObject3DComponent(world, myEid, mesh);

    addComponent(world, CursorRaycastable, myEid);
    addComponent(world, RemoteHoverTarget, myEid);
    addComponent(world, SingleActionButton, myEid);

    world.scene.add(mesh);
  }

  const now = world.time.elapsed;

  clickedQuery(world).forEach(eid => {
    if (eid !== myEid) return;
    const obj = world.eid2obj.get(eid);
    if (obj instanceof Mesh) {
      spin = { startTime: now, startY: obj.rotation.y };
    }
  });

  if (spin) {
    const obj = world.eid2obj.get(myEid);
    if (obj) {
      const t = (now - spin.startTime) / SPIN_DURATION;
      if (t >= 1) {
        obj.rotation.y = spin.startY + Math.PI * 2;
        spin = null;
      } else {
        obj.rotation.y = spin.startY + t * Math.PI * 2;
      }
      obj.updateMatrix();
    }
  }
}
