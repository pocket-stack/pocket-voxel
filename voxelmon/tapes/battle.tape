# battle.tape — the wild-battle core end to end: reach the ROUTE_1 grass
# patch on the proven story route (seed 17: the encounter fires on the
# (14,9) landing), then exercise FIGHT (move 1) and RUN, with marks that
# render the battle screen itself. The player's SQUIRTLE outspeeds the wild
# PIDGEY L3, so TryRunningFromBattle escapes on the first attempt.
# Run: bun apps/voxelmon/game/sim/cli.ts
#   --tape apps/voxelmon/tapes/battle.tape
#   --out dist/voxelmon/trace/battle.vtrace --seed 17

# bedroom -> stairs -> 1F -> Pallet (the story.tape route, unchanged so the
# rng stream reaches the grass in the same state)
wait 5
walk r 1
walk u 4
walk r 3
walk u 1
wait 40
walk d 5
walk l 4
walk d 1
walk d 1
wait 30

# read the town sign (keeps the route identical to story.tape)
walk d 2
walk r 2
press d
wait 10
press a
wait 100
press a
wait 80
press a
wait 10

# Oak's lab in and out
walk r 2
walk d 4
walk r 3
walk u 1
wait 40
walk d 1
wait 30

# north out of Pallet onto ROUTE_1
walk l 3
walk u 10
walk r 1
walk u 3
wait 10

# Route 1 northbound to the big grass patch
walk u 3
walk u 4
walk l 3
walk u 4
walk r 5
walk u 4
walk l 3
walk u 6
walk r 5
walk u 2
walk u 2
mark grass-edge

# the encounter fires on this landing
walk u 1
# intro: the 72-tick slide + "Wild PIDGEY appeared!" types out
wait 200
mark battle-intro
press a
# send-out beats + "Go! SQUIRTLE!"
wait 150
press a
# action menu opens on FIGHT
wait 20
press a
# move menu opens on slot 1 (TACKLE)
wait 10
press a
# the exchange resolves
wait 400
mark post-fight
# FIGHT -> RUN (row 1, col 1)
press d
press r
press a
# "Got away safely!" then the battle pops (POST_BATTLE_RETURN)
wait 100
press a
wait 30
mark escaped
