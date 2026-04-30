import { addComponent, addEntity, defineQuery, enterQuery } from "bitecs";
import { BoxGeometry, Mesh, MeshStandardMaterial } from "three";
import { addObject3DComponent } from "../utils/jsx-entity";
import { HubsWorld } from "../app";
import { CursorRaycastable, RemoteHoverTarget, SingleActionButton, Interacted } from "../bit-components";

let myEid = -1;

const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff];
let colorIndex = 0;

const clickedQuery = enterQuery(defineQuery([SingleActionButton, Interacted]));

export function colourToggleSystem(world: HubsWorld) {
  if (myEid === -1) {
    myEid = addEntity(world);
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: colors[0] }));
    mesh.position.set(0, 1.5, 0);
    addObject3DComponent(world, myEid, mesh);

    addComponent(world, CursorRaycastable, myEid);
    addComponent(world, RemoteHoverTarget, myEid);
    addComponent(world, SingleActionButton, myEid);

    world.scene.add(mesh);
  }

  clickedQuery(world).forEach(eid => {
    if (eid !== myEid) return;
    const obj = world.eid2obj.get(eid);
    if (obj instanceof Mesh) {
      colorIndex = (colorIndex + 1) % colors.length;
      (obj.material as MeshStandardMaterial).color.set(colors[colorIndex]);
    }
  });
}
