/** @jsx createElementEntity */
import { createElementEntity } from "../utils/jsx-entity";
import { ProjectionMode } from "./projection-mode";
import { loadTextureCancellable } from "../utils/load-texture";
import { renderAsEntity } from "../utils/jsx-entity";
import { HubsWorld } from "../app";
import { Texture } from "three";
import { AlphaMode } from "./create-image-mesh";
import { ImageParams } from "../inflators/image";
import { EntityID } from "./networking-types";
import { ObjectMenuTarget } from "../bit-components";
import { ObjectMenuTargetFlags } from "../inflators/object-menu-target";

export function* createImageDef(world: HubsWorld, url: string, contentType: string): Generator<any, ImageParams, any> {
  const { texture, ratio, cacheKey }: { texture: Texture; ratio: number; cacheKey: string } =
    yield loadTextureCancellable(url, 1, contentType);

  // TODO it would be nice if we could be less aggressive with transparency here.
  // Doing so requires inspecting the raw file data upstream of here and passing
  // that info through somehow which feels tricky.
  let alphaMode: AlphaMode = AlphaMode.BLEND;
  if (contentType === "image/gif") {
    alphaMode = AlphaMode.MASK;
  } else if (contentType === "image/jpeg") {
    alphaMode = AlphaMode.OPAQUE;
  }

  return {
    texture,
    ratio,
    projection: ProjectionMode.FLAT,
    alphaMode,
    alphaCutoff: 0.5,
    cacheKey
  };
}

type Params = {
  alphaCutoff?: number;
  alphaMode?: AlphaMode;
  projection?: ProjectionMode;
};

export function* loadImage(world: HubsWorld, eid: EntityID, url: string, contentType: string, params: Params) {
  const { alphaCutoff, alphaMode, projection } = params;

  const imageDef = yield* createImageDef(world, url, contentType);

  if (alphaCutoff !== undefined) {
    imageDef.alphaCutoff = alphaCutoff;
  }

  if (alphaMode !== undefined) {
    imageDef.alphaMode = alphaMode;
  }

  if (projection !== undefined) {
    imageDef.projection = projection;
  }

  // A 360 image is built as a sphere the viewer stands inside (see inflateImage), so it can
  // never be usefully grabbed or menued. Making it a cursor target is actively harmful: the
  // cursor ray hits the surrounding sphere in every direction, so the hovering-an-interactable
  // action set stays permanently active and starves the mouse-look binding, leaving desktop
  // users unable to turn the camera at all.
  //
  // Omitting grabbable here is not enough on its own: findRemoteHoverTarget walks *up* the
  // parent chain, so it would just keep climbing to the RemoteHoverTarget on the MediaPrefab
  // root. isNotRemoteHoverTarget is checked before that climb, so it short-circuits the whole
  // ancestry regardless of which prefab wrapped this image.
  if (imageDef.projection === ProjectionMode.SPHERE_EQUIRECTANGULAR) {
    return renderAsEntity(world, <entity name="Image" image={imageDef} />);
  }
  ObjectMenuTarget.flags[eid] |= ObjectMenuTargetFlags.Flat;

  return renderAsEntity(
    world,
    <entity
      name="Image"
      image={imageDef}
      objectMenuTarget={{ isFlat: true }}
      grabbable={{ cursor: true, hand: false }}
    />
  );
}
