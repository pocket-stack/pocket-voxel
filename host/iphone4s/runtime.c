#define POCKET_ACCEPTANCE_PATH "/private/var/tmp/pocketvoxel-iphone4s.status"
#define POCKET_ACCEPTANCE_TEMP "/private/var/tmp/pocketvoxel-iphone4s.status.new"
#define POCKET_CAPTURE_REQUEST_PATH "/private/var/tmp/pocketvoxel-iphone4s.capture"
#define POCKET_CAPTURE_OUTPUT_PATH "/private/var/tmp/pocketvoxel-iphone4s.frame.rgba"
#define POCKET_PREFER_GL_PATH "/private/var/tmp/pocketvoxel-iphone4s.gles1"
#define POCKET_GL_DEFAULT 1
#define POCKET_REQUIRE_GL 1

/* Reuse the physically validated iOS 6 UIKit/Retina/CAEAGLLayer shell. */
#include "../../vendor/pocketjs/hosts/iphone2g/runtime.c"
