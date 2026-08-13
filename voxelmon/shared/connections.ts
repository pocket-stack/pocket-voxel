// Browser-safe connected-map placement shared by the cooker and guest.
// Connection offsets are ROM block units (32 world px); map dimensions are
// block counts. Keep filesystem and runtime-only types out of this module.

export type ConnectionDirection = "north" | "south" | "east" | "west";

export interface ConnectionPlacementMap {
  width: number;
  height: number;
}

export interface DirectConnection {
  offset: number;
}

/** Place one directly connected map in the current map's local world space. */
export function placeDirectNeighbour(
  direction: ConnectionDirection,
  connection: DirectConnection,
  current: ConnectionPlacementMap,
  destination: ConnectionPlacementMap,
): { ox: number; oy: number } {
  if (direction === "north") {
    return { ox: connection.offset * 32, oy: -destination.height * 32 };
  }
  if (direction === "south") {
    return { ox: connection.offset * 32, oy: current.height * 32 };
  }
  if (direction === "west") {
    return { ox: -destination.width * 32, oy: connection.offset * 32 };
  }
  return { ox: current.width * 32, oy: connection.offset * 32 };
}
