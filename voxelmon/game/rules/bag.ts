// The bag. Ports gen1recomp src/inventory/Bag.lua: 20 slots
// (BAG_ITEM_CAPACITY, pokered constants/menu_constants.asm), overridable
// through data.constants.bagSize. A distinct item id occupies one slot
// regardless of quantity; badges live in the inventory table but are not bag
// items. save.bagOrder keeps acquisition order like wBagItems (SELECT can
// reorder it).
//
// One divergence: the Lua's capacity() falls back to the Data singleton when
// no dataset is passed; this port has no singleton, so an omitted `data`
// resolves straight to the vanilla limit.

import type { VoxelmonData } from "../data.ts";

const DEFAULT_CAPACITY = 20;

/** The save fields the bag reads and maintains. */
export interface BagSave {
  /** id -> quantity (badges included; they are inventory, not bag items). */
  inventory: Record<string, number>;
  /** Acquisition-ordered non-badge id list (wBagItems). */
  bagOrder?: string[];
}

/** Bag.lua:16-23 capacity — configured bagSize (floored, >= 1) or 20. */
export function capacity(data?: Pick<VoxelmonData, "constants">): number {
  const configured = data?.constants?.bagSize;
  if (typeof configured === "number" && configured >= 1) {
    return Math.floor(configured);
  }
  return DEFAULT_CAPACITY;
}

/**
 * Bag.lua:25-31 isBadge — exported so item lists that share save.inventory
 * (e.g. the PC deposit menu) can exclude badges the same way the bag does.
 */
export function isBadge(id: string): boolean {
  return id.includes("BADGE");
}

/** Bag.lua:33-39 slots — occupied bag slots (badges excluded). */
export function slots(save: BagSave): number {
  let n = 0;
  for (const id of Object.keys(save.inventory)) {
    if (!isBadge(id)) n += 1;
  }
  return n;
}

/**
 * Bag.lua:43-68 order — acquisition-ordered id list (wBagItems). Rebuilt
 * sorted once for saves from before the order existed, then maintained
 * incrementally: stale ids drop, unknown ones append (defensive against
 * direct inventory writes).
 */
export function order(save: BagSave): string[] {
  let list = save.bagOrder;
  if (!list) {
    list = [];
    for (const id of Object.keys(save.inventory)) {
      if (!isBadge(id)) list.push(id);
    }
    list.sort();
    save.bagOrder = list;
  }
  const seen = new Set<string>();
  for (let i = list.length - 1; i >= 0; i--) {
    const id = list[i];
    if (save.inventory[id] === undefined || seen.has(id)) {
      list.splice(i, 1);
    } else {
      seen.add(id);
    }
  }
  for (const id of Object.keys(save.inventory)) {
    if (!isBadge(id) && !seen.has(id)) list.push(id);
  }
  return list;
}

/**
 * Bag.lua:73-88 add — add qty of an item; returns false (and adds nothing)
 * when a new slot is needed and the bag is full, or when the stack would
 * pass 99 (AddItemToInventory's per-slot quantity cap).
 */
export function add(
  save: BagSave,
  id: string,
  qty?: number,
  data?: Pick<VoxelmonData, "constants">,
): boolean {
  const inv = save.inventory;
  if (inv[id] === undefined && !isBadge(id) && slots(save) >= capacity(data)) {
    return false;
  }
  if (!isBadge(id) && (inv[id] ?? 0) + (qty ?? 1) > 99) {
    return false;
  }
  const isNew = inv[id] === undefined;
  inv[id] = (inv[id] ?? 0) + (qty ?? 1);
  if (isNew && !isBadge(id)) {
    order(save).push(id);
  }
  return true;
}

/**
 * Bag.lua:91-104 remove — remove qty (default 1); clears the slot and its
 * order entry at zero.
 */
export function remove(save: BagSave, id: string, qty?: number): void {
  const inv = save.inventory;
  inv[id] = (inv[id] ?? 0) - (qty ?? 1);
  if (inv[id] <= 0) {
    delete inv[id];
    const list = save.bagOrder;
    if (list) {
      const i = list.indexOf(id);
      if (i !== -1) list.splice(i, 1);
    }
  }
}
