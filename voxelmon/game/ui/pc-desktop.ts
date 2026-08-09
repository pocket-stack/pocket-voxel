// The bedroom PC's native overlay. The interaction state lives in game.ts;
// this module is only the presentation program it exposes to Scene. Geometry
// and colours distil Pocket Shell's Win98 theme into the voxel surface's
// retained, screen-space primitives — no browser/DOM or device SDK concepts.

import type { VoxelHost } from "../host.ts";

export type PcDesktopPage = "home" | "pokedex" | "storage" | "mail";

export interface PcPartyRow {
  name: string;
  level: number;
  hp: number;
  maxHp: number;
}

/** What Scene needs to render the topmost PC desktop state. */
export interface PcDesktopSource {
  /** Incremented whenever an input changes something visible. */
  revision: number;
  page: PcDesktopPage;
  selected: number;
  status: string;
  trainerName: string;
  boxNumber: number;
  readMail: readonly boolean[];
  party: readonly PcPartyRow[];
}

export const PC_HOME_ROWS = ["POKEDEX 95", "BOX NETWORK", "TRAINER MAIL", "LOG OFF"] as const;
export const PC_DEX_ROWS = ["001 BULBASAUR", "004 CHARMANDER", "007 SQUIRTLE"] as const;
export const PC_MAIL_ROWS = ["PROF. OAK", "BILL", "MOM"] as const;

// ABGR, matching voxel-spec.ts and both native backends.
const rgb = (r: number, g: number, b: number): number =>
  (0xff00_0000 | (b << 16) | (g << 8) | r) | 0;

const C = {
  black: rgb(0x00, 0x00, 0x00),
  white: rgb(0xff, 0xff, 0xff),
  face: rgb(0xc0, 0xc0, 0xc0),
  light: rgb(0xdf, 0xdf, 0xdf),
  shadow: rgb(0x80, 0x80, 0x80),
  title: rgb(0x00, 0x00, 0x80),
  title2: rgb(0x10, 0x84, 0xd0),
  teal: rgb(0x00, 0x80, 0x80),
  pokemonRed: rgb(0xe3, 0x35, 0x0d),
  pokemonYellow: rgb(0xf8, 0xd0, 0x30),
  pokemonBlue: rgb(0x2a, 0x75, 0xbb),
} as const;

function rect(host: VoxelHost, x: number, y: number, w: number, h: number, color: number): void {
  if (w > 0 && h > 0) host.uiRect(x, y, w, h, color);
}

function label(
  host: VoxelHost,
  x: number,
  y: number,
  text: string,
  color = C.black,
  scale = 1,
): void {
  host.uiLabel(x, y, scale, color, text);
}

/** Win98 raised edge: white/light top-left, shadow/black bottom-right. */
function raised(host: VoxelHost, x: number, y: number, w: number, h: number): void {
  rect(host, x, y, w, h, C.face);
  rect(host, x, y, w - 1, 1, C.white);
  rect(host, x, y, 1, h - 1, C.white);
  rect(host, x + 1, y + 1, w - 3, 1, C.light);
  rect(host, x + 1, y + 1, 1, h - 3, C.light);
  rect(host, x + w - 2, y + 1, 1, h - 1, C.shadow);
  rect(host, x + 1, y + h - 2, w - 1, 1, C.shadow);
  rect(host, x + w - 1, y, 1, h, C.black);
  rect(host, x, y + h - 1, w, 1, C.black);
}

/** Win98 sunken well: dark top-left, white bottom-right. */
function sunken(host: VoxelHost, x: number, y: number, w: number, h: number): void {
  rect(host, x, y, w, h, C.white);
  rect(host, x, y, w - 1, 1, C.shadow);
  rect(host, x, y, 1, h - 1, C.shadow);
  rect(host, x + 1, y + 1, w - 3, 1, C.black);
  rect(host, x + 1, y + 1, 1, h - 3, C.black);
  rect(host, x + w - 2, y + 1, 1, h - 1, C.light);
  rect(host, x + 1, y + h - 2, w - 1, 1, C.light);
  rect(host, x + w - 1, y, 1, h, C.white);
  rect(host, x, y + h - 1, w, 1, C.white);
}

function titleGradient(host: VoxelHost, x: number, y: number, w: number, h: number): void {
  // Pocket Shell uses #000080 -> #1084d0. Eight stripes keep the tiny native
  // renderer deterministic while preserving the era's visible gradient.
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const r = Math.round(0x00 + (0x10 - 0x00) * t);
    const g = Math.round(0x00 + (0x84 - 0x00) * t);
    const b = Math.round(0x80 + (0xd0 - 0x80) * t);
    const x0 = x + Math.floor((w * i) / 8);
    const x1 = x + Math.floor((w * (i + 1)) / 8);
    rect(host, x0, y, x1 - x0, h, rgb(r, g, b));
  }
}

function homeRows(view: PcDesktopSource): readonly string[] {
  switch (view.page) {
    case "pokedex":
      return PC_DEX_ROWS;
    case "storage":
      return view.party.length > 0
        ? view.party.map((mon) => `${mon.name}  L${mon.level}  HP ${mon.hp}/${mon.maxHp}`)
        : ["NO POKEMON IN PARTY"];
    case "mail":
      return PC_MAIL_ROWS.map((sender, i) => `${view.readMail[i] ? "READ" : "NEW "}  ${sender}`);
    default:
      return PC_HOME_ROWS;
  }
}

function pagePath(view: PcDesktopSource): string {
  switch (view.page) {
    case "pokedex":
      return "C:\\PALLETNET\\POKEDEX95";
    case "storage":
      return `C:\\PALLETNET\\BOX${String(view.boxNumber).padStart(2, "0")}`;
    case "mail":
      return "C:\\PALLETNET\\TRAINER MAIL";
    default:
      return "C:\\PALLETNET\\THIS PC";
  }
}

function pageTitle(view: PcDesktopSource): string {
  switch (view.page) {
    case "pokedex":
      return "POKEDEX 95";
    case "storage":
      return `BOX NETWORK - BOX ${String(view.boxNumber).padStart(2, "0")}`;
    case "mail":
      return "TRAINER MAIL";
    default:
      return "THIS PC";
  }
}

function pageHint(view: PcDesktopSource): string {
  if (view.page === "home") return "A OPEN   B/START CLOSE";
  if (view.page === "storage") return "LEFT/RIGHT BOX   A SYNC   B BACK";
  if (view.page === "mail") return "A READ   B BACK";
  return "A VIEW DATA   B BACK";
}

/** Rebuild the full retained overlay after a visible state revision. */
export function emitPcDesktop(host: VoxelHost, view: PcDesktopSource): void {
  const x = 50;
  const y = 26;
  const w = 380;
  const h = 220;

  // The game remains visible around this shadow/window: this is deliberately
  // not Pocket Shell's full-screen teal desktop.
  rect(host, x + 6, y + 6, w, h, rgb(0x20, 0x20, 0x20));
  raised(host, x, y, w, h);

  const innerX = x + 4;
  const innerW = w - 8;
  titleGradient(host, innerX, y + 4, innerW, 18);
  label(host, innerX + 7, y + 10, `PALLET PC - ${view.trainerName}`, C.white);

  // Caption close button. Controller B/START and the LOG OFF row all call the
  // same close path; the visible X makes that affordance unambiguous.
  raised(host, x + w - 23, y + 6, 16, 14);
  label(host, x + w - 18, y + 10, "X", C.black);

  // Toolbar and address row.
  raised(host, innerX, y + 25, 46, 19);
  label(host, innerX + 8, y + 31, "BACK");
  raised(host, innerX + 49, y + 25, 46, 19);
  label(host, innerX + 58, y + 31, "HOME");
  label(host, innerX + 103, y + 32, "ADDRESS");
  sunken(host, innerX + 151, y + 25, innerW - 151, 19);
  label(host, innerX + 156, y + 31, pagePath(view));

  const panesY = y + 47;
  const panesH = 137;
  sunken(host, innerX, panesY, 100, panesH);
  rect(host, innerX + 3, panesY + 3, 94, 26, C.teal);
  label(host, innerX + 9, panesY + 9, "PALLETNET", C.white);
  label(host, innerX + 8, panesY + 39, "THIS PC");
  label(host, innerX + 8, panesY + 55, "POKEDEX");
  label(host, innerX + 8, panesY + 71, "BILL'S PC");
  label(host, innerX + 8, panesY + 87, "OAK MAIL");
  rect(host, innerX + 8, panesY + 108, 10, 10, C.pokemonYellow);
  rect(host, innerX + 20, panesY + 108, 10, 10, C.pokemonRed);
  rect(host, innerX + 32, panesY + 108, 10, 10, C.pokemonBlue);

  const listX = innerX + 103;
  const listW = innerW - 103;
  sunken(host, listX, panesY, listW, panesH);
  label(host, listX + 7, panesY + 7, pageTitle(view));
  rect(host, listX + 4, panesY + 18, listW - 8, 1, C.shadow);

  const rows = homeRows(view);
  // Four rows fit in the pane. Storage can contain a full six-mon party, so
  // scroll the visible window just enough to keep its selected row on screen.
  const rowStart = Math.max(0, Math.min(view.selected - 3, rows.length - 4));
  for (let visible = 0; visible < 4 && rowStart + visible < rows.length; visible++) {
    const i = rowStart + visible;
    const rowY = panesY + 23 + visible * 25;
    const chosen = i === view.selected;
    if (chosen) rect(host, listX + 4, rowY, listW - 8, 21, C.title);
    // Small Pokémon-coloured file icons; their white corner gives the old
    // Explorer document silhouette without importing Windows artwork.
    const icon = [C.pokemonYellow, C.pokemonBlue, C.pokemonRed, C.face][i % 4]!;
    rect(host, listX + 9, rowY + 4, 12, 13, icon);
    rect(host, listX + 17, rowY + 4, 4, 4, C.white);
    label(host, listX + 28, rowY + 7, rows[i]!, chosen ? C.white : C.black);
  }

  // Status bar: one sunken field for mutable mock-operation feedback and one
  // for the controller contract.
  const statusY = y + h - 31;
  sunken(host, innerX, statusY, 156, 20);
  label(host, innerX + 6, statusY + 7, view.status);
  sunken(host, innerX + 159, statusY, innerW - 159, 20);
  label(host, innerX + 165, statusY + 7, pageHint(view));
}
