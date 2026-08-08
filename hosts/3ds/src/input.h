/* 3DS keys -> the VOX_BTN mask. See input.c. */
#ifndef POCKETVOXEL_3DS_INPUT_H
#define POCKETVOXEL_3DS_INPUT_H

#include <stdint.h>

/* This tick's VOX_BTN mask, from hidScanInput's held state and the circle
 * pad. */
int32_t input_buttons(void);

#endif /* POCKETVOXEL_3DS_INPUT_H */
