# story.tape — the overworld vertical slice, end to end (docs/VOXEL.md §9):
# wake in the bedroom (REDS_HOUSE_2F 3,6), take the stairs down, leave the
# house, read the Pallet Town sign, visit Oak's lab and step back out, walk
# Route 1 north through the grass until a wild encounter opens the REAL
# battle (fight one round with move 1, then RUN — the player's speed beats
# the wild mon's, so TryRunningFromBattle always escapes), and finish in
# Viridian City.
#
# Cell paths are plotted against dist/voxelmon/gen walkability grids; the
# wild encounter fires on the (14,9) grass landing on ROUTE_1 with the
# tested seed. Run: bun apps/voxelmon/game/sim/cli.ts
#   --tape apps/voxelmon/tapes/story.tape
#   --out dist/voxelmon/trace/story.vtrace --seed 17

# settle one scene emission before the first checkpoint renders
wait 5
mark bedroom

# bedroom -> stairs at (7,1); the stairs warp fires on ARRIVAL
walk r 1
walk u 4
walk r 3
walk u 1
wait 40
mark downstairs

# 1F (7,1) -> the exit mats at (3,7); walking off the bottom edge fires the
# edge warp (standing-on-warp rides the plain mat tile), landing on the
# Pallet door (5,5) + the auto walk-out step south to (5,6)
walk d 5
walk l 4
walk d 1
walk d 1
wait 30
mark pallet-town

# to the town sign at (7,9): stand on (7,8), face down, read both pages
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
mark sign-read

# to Oak's lab door (12,11); the door tile warps on arrival into the lab
walk r 2
walk d 4
walk r 3
walk u 1
wait 40
mark oaks-lab

# straight back out: the lab exit (5,11) is an edge warp onto the Pallet
# lab door, which auto-steps south to (12,12)
walk d 1
wait 30
mark lab-exit

# north out of Pallet through the (10,*) opening; the seam step onto
# ROUTE_1 (10,35) lands in grass
walk l 3
walk u 10
walk r 1
walk u 3
wait 10
mark route-1

# Route 1 northbound, threading the ledge openings
walk u 3
walk u 4
walk l 3
walk u 4
walk r 5
walk u 4
walk l 3
walk u 6
walk r 5
mark mid-route

# into the big grass patch; the wild encounter fires on the (14,9) landing
walk u 2
walk u 2
walk u 1
# intro: the 72-tick silhouette slide + "Wild PIDGEY appeared!" types out
wait 200
press a
# send-out beats (40 + 18) + "Go! SQUIRTLE!" types
wait 150
press a
# POOF row resolves, the action menu opens on FIGHT
wait 20
press a
# move menu opens on slot 1 (TACKLE)
wait 10
press a
# one full exchange: used-move texts, anim beats, HP drains, residual acts
wait 400
# back at the menu on FIGHT; RUN is row 1 col 1
press d
press r
press a
# "Got away safely!" types, then A dismisses and the battle pops
wait 100
press a
wait 30
mark encounter-seen

# out the top of the patch and up the (10,*)/(11,*) corridor
walk u 3
walk u 4
walk l 4
walk u 2
walk u 1
wait 10
mark viridian

# a few steps into town to close on solid ground
walk u 3
wait 10
mark done
