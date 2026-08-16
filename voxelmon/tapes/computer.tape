# Red's bedroom PC: ROM hidden event -> native local/remote choice ->
# retained Win98-style local overlay -> mock storage operation -> close.
walk l 2
walk u 4
walk l 1
press u
wait 4
press a
wait 180
mark pc-choice

# LOCAL PC is selected by default. The original choice box holds its answer
# for 15 frames before handing control to the desktop.
press a
wait 15
mark pc-home

# BOX NETWORK -> BOX 02 -> SYNC, then back out through both modal levels.
press d
press a
mark pc-storage
press r
press a
mark pc-synced
press b
press b
mark pc-closed

# Reopen from the same tile and take REMOTE PC. With no mock stream the
# modal shell stays WAITING and retries until B disconnects it.
press a
wait 180
press d
press a
wait 15
mark pc-remote-waiting
press b
wait 4
mark pc-remote-closed
