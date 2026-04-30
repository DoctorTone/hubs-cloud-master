import { NetworkedAnimationOnClick } from "../bit-components";
import { defineNetworkSchema } from "./define-network-schema";
import { deserializerWithMigrations, Migration, NetworkSchema, read, StoredComponent, write } from "./network-schemas";
import type { EntityID } from "./networking-types";

const runtimeSerde = defineNetworkSchema(NetworkedAnimationOnClick);

const migrations = new Map<number, Migration>();

function apply(eid: EntityID, { version, data }: StoredComponent) {
  if (version !== 1) return false;
  write(NetworkedAnimationOnClick.playing, eid, (data as any).playing);
  return true;
}

export const NetworkedAnimationOnClickSchema: NetworkSchema = {
  componentName: "networked-animation-on-click",
  serialize: runtimeSerde.serialize,
  deserialize: runtimeSerde.deserialize,
  serializeForStorage: function serializeForStorage(eid: EntityID) {
    return {
      version: 1,
      data: {
        playing: read(NetworkedAnimationOnClick.playing, eid)
      }
    };
  },
  deserializeFromStorage: deserializerWithMigrations(migrations, apply)
};
