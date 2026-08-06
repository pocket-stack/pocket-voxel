// The hand-ported map scripts, the registry half of gen1recomp
// data/scripts/init.lua + src/script/MapScripts.lua: map-specific behavior
// lives HERE, never in the world classes.
//
// Each entry is { talk: { TEXT_CONST: ScriptRow[] } } — the shape
// MapScripts.attachBase takes and ScriptRunner executes. Every script cites
// the upstream file it was transcribed from, which in turn cites the pokered
// script it ports; text arguments are the extracted labels (`_Label`), never
// prose typed in here, so nothing ROM-derived is committed (docs/VOXEL.md §1).
//
// Scope: the maps this build cooks (cook/cli.ts DEFAULT_MAPS). Two upstream
// scripts for those maps are NOT here, both needing rungs docs/VOXEL.md §10
// defers: data/scripts/oaks_lab.lua (the starter-choice cutscene — object
// visibility, a forced walk, and the rival battle) and story2.lua's
// PALLET_TOWN onStep (Oak stopping the player at the grass and walking them
// to the lab, which this build's newGame has already happened — the starter
// is in the party from the first frame, so the flag branches below resolve
// the way upstream's do once that cutscene is over).

import type { ScriptRow } from "./script.ts";

export interface MapScript {
  /** Keyed by the object's TEXT_* constant, the way MapScripts.talk does. */
  talk?: Record<string, ScriptRow[]>;
}

export const MAP_SCRIPTS: Record<string, MapScript> = {
  // data/scripts/reds_house.lua (pokered scripts/RedsHouse1F.asm). Mom:
  // pre-starter shows the wake-up / Oak tip; after EVENT_GOT_STARTER,
  // RedsHouse1FMomHealScript fades to white, heals, plays MUSIC_PKMN_HEALED,
  // fades back, then "looking great".
  REDS_HOUSE_1F: {
    talk: {
      TEXT_REDSHOUSE1F_MOM: [
        ["face_player"], //                                        1
        ["check_flag", "EVENT_GOT_STARTER"], //                     2
        ["jump_if_true", 6], //                                     3
        ["show_text", "_RedsHouse1FMomWakeUpText"], //              4
        ["jump", "end"], //                                         5
        // RedsHouse1FMomHealScript
        ["show_text", "_RedsHouse1FMomYouShouldRestText"], //       6
        ["fade", "out", "white"], //                                7  GBFadeOutToWhite
        ["heal_party"], //                                          8
        ["play_once", "Music_PkmnHealed"], //                       9
        ["fade", "in", "white"], //                                10  GBFadeInFromWhite
        ["show_text", "_RedsHouse1FMomLookingGreatText"], //       11
      ],
    },
  },

  // data/scripts/pallet_town.lua (pokered scripts/PalletTown.asm).
  // PalletTownOakText is a text_asm branch on wOakWalkedToPlayer showing
  // either _PalletTownOakHeyWaitDontGoOutText or _PalletTownOakItsUnsafeText;
  // upstream branches on the starter flag, which tracks it. The champion
  // rematch rows (upstream 2-19) need a trainer battle and are left out with
  // the rest of §10's trainer rung — the branch that survives is the one v1
  // content can reach.
  PALLET_TOWN: {
    talk: {
      TEXT_PALLETTOWN_OAK: [
        ["face_player"], //                                         1
        ["check_flag", "EVENT_GOT_STARTER"], //                      2
        ["jump_if_true", 6], //                                      3
        ["show_text", "_PalletTownOakHeyWaitDontGoOutText"], //      4
        ["jump", "end"], //                                          5
        ["show_text", "_PalletTownOakItsUnsafeText"], //             6
      ],
    },
  },
};

/**
 * MapScripts.lua:239 talkScript — the script for an object's TEXT_* constant
 * on a map, or null when nothing is registered and the plain extracted text
 * is what the player should see.
 */
export function talkScript(mapLabel: string, textConst: string): ScriptRow[] | null {
  return MAP_SCRIPTS[mapLabel]?.talk?.[textConst] ?? null;
}
