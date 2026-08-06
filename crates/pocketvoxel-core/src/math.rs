//! Minimal f32 vector/matrix math, written here instead of pulling glam:
//! the core keeps the zero-dependency discipline, and the sim rasterizer and
//! the GE backend must agree bit-for-bit on the few operations we use.
//!
//! Conventions: right-handed, +Y up, column-major [`Mat4`] (like glam / the
//! GE), GL-style -1..1 clip depth (what the GE consumes).

/// Trig/sqrt shim: std intrinsics on desktop, libm on the PSP.
#[cfg(feature = "std")]
mod ff {
    #[inline]
    pub fn sinf(x: f32) -> f32 {
        x.sin()
    }
    #[inline]
    pub fn cosf(x: f32) -> f32 {
        x.cos()
    }
    #[inline]
    pub fn tanf(x: f32) -> f32 {
        x.tan()
    }
    #[inline]
    pub fn atanf(x: f32) -> f32 {
        x.atan()
    }
    #[inline]
    pub fn atan2f(y: f32, x: f32) -> f32 {
        y.atan2(x)
    }
    #[inline]
    pub fn sqrtf(x: f32) -> f32 {
        x.sqrt()
    }
}

#[cfg(not(feature = "std"))]
mod ff {
    pub use libm::{atan2f, atanf, cosf, sinf, sqrtf, tanf};
}

pub use ff::{atan2f, atanf, cosf, sinf, sqrtf, tanf};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

pub const fn vec3(x: f32, y: f32, z: f32) -> Vec3 {
    Vec3 { x, y, z }
}

impl Vec3 {
    pub const ZERO: Vec3 = vec3(0.0, 0.0, 0.0);
    pub const Y: Vec3 = vec3(0.0, 1.0, 0.0);

    #[inline]
    pub fn add(self, o: Vec3) -> Vec3 {
        vec3(self.x + o.x, self.y + o.y, self.z + o.z)
    }
    #[inline]
    pub fn sub(self, o: Vec3) -> Vec3 {
        vec3(self.x - o.x, self.y - o.y, self.z - o.z)
    }
    #[inline]
    pub fn scale(self, s: f32) -> Vec3 {
        vec3(self.x * s, self.y * s, self.z * s)
    }
    #[inline]
    pub fn dot(self, o: Vec3) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    #[inline]
    pub fn cross(self, o: Vec3) -> Vec3 {
        vec3(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }
    #[inline]
    pub fn length(self) -> f32 {
        sqrtf(self.dot(self))
    }
    /// Normalize; a near-zero vector comes back unchanged (callers guard the
    /// degenerate cases they care about).
    #[inline]
    pub fn normalize(self) -> Vec3 {
        let len = self.length();
        if len > 1e-12 {
            self.scale(1.0 / len)
        } else {
            self
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec4 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

pub const fn vec4(x: f32, y: f32, z: f32, w: f32) -> Vec4 {
    Vec4 { x, y, z, w }
}

impl Vec4 {
    #[inline]
    pub fn add(self, o: Vec4) -> Vec4 {
        vec4(self.x + o.x, self.y + o.y, self.z + o.z, self.w + o.w)
    }
    #[inline]
    pub fn dot(self, o: Vec4) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z + self.w * o.w
    }
}

/// Column-major 4x4: `m[col * 4 + row]`, matching glam's `to_cols_array` and
/// the GE's `ScePspFMatrix4` layout, so the future gu backend can memcpy it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat4 {
    pub m: [f32; 16],
}

impl Mat4 {
    pub const IDENTITY: Mat4 = Mat4 {
        m: [
            1.0, 0.0, 0.0, 0.0, //
            0.0, 1.0, 0.0, 0.0, //
            0.0, 0.0, 1.0, 0.0, //
            0.0, 0.0, 0.0, 1.0,
        ],
    };

    #[inline]
    pub fn row(&self, r: usize) -> Vec4 {
        vec4(self.m[r], self.m[4 + r], self.m[8 + r], self.m[12 + r])
    }

    /// `self * rhs` (apply `rhs` first).
    pub fn mul(&self, rhs: &Mat4) -> Mat4 {
        let mut out = [0.0f32; 16];
        for c in 0..4 {
            for r in 0..4 {
                let mut acc = 0.0;
                for k in 0..4 {
                    acc += self.m[k * 4 + r] * rhs.m[c * 4 + k];
                }
                out[c * 4 + r] = acc;
            }
        }
        Mat4 { m: out }
    }

    /// `self * (v, w)`. `w = 1` transforms a point, `w = 0` a direction —
    /// the horizon-at-infinity derivation feeds a direction through the VP.
    #[inline]
    pub fn transform(&self, v: Vec3, w: f32) -> Vec4 {
        let m = &self.m;
        vec4(
            m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12] * w,
            m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13] * w,
            m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14] * w,
            m[3] * v.x + m[7] * v.y + m[11] * v.z + m[15] * w,
        )
    }

    /// GL-style perspective (-1..1 clip depth, what the GE consumes).
    pub fn perspective_gl(fov_y: f32, aspect: f32, near: f32, far: f32) -> Mat4 {
        let f = 1.0 / tanf(fov_y * 0.5);
        let nf = 1.0 / (near - far);
        let mut m = [0.0f32; 16];
        m[0] = f / aspect;
        m[5] = f;
        m[10] = (far + near) * nf;
        m[11] = -1.0;
        m[14] = 2.0 * far * near * nf;
        Mat4 { m }
    }

    /// Right-handed look-at (eye toward `center`, `up` roughly up).
    pub fn look_at(eye: Vec3, center: Vec3, up: Vec3) -> Mat4 {
        let f = center.sub(eye).normalize();
        let s = f.cross(up).normalize();
        let u = s.cross(f);
        let mut m = [0.0f32; 16];
        m[0] = s.x;
        m[1] = u.x;
        m[2] = -f.x;
        m[4] = s.y;
        m[5] = u.y;
        m[6] = -f.y;
        m[8] = s.z;
        m[9] = u.z;
        m[10] = -f.z;
        m[12] = -s.dot(eye);
        m[13] = -u.dot(eye);
        m[14] = f.dot(eye);
        m[15] = 1.0;
        Mat4 { m }
    }
}

/// View frustum extracted from a clip-from-world matrix (Gribb–Hartmann),
/// GL depth convention — the same recipe as `pocket3d_bsp::vis::Frustum`,
/// re-derived here over our own [`Mat4`] to keep the crate dependency-free.
#[derive(Clone, Copy, Debug)]
pub struct Frustum {
    planes: [Vec4; 6],
}

impl Frustum {
    pub fn from_clip(m: &Mat4) -> Frustum {
        let r0 = m.row(0);
        let r1 = m.row(1);
        let r2 = m.row(2);
        let r3 = m.row(3);
        let neg = |v: Vec4| vec4(-v.x, -v.y, -v.z, -v.w);
        Frustum {
            planes: [
                r3.add(r0),
                r3.add(neg(r0)),
                r3.add(r1),
                r3.add(neg(r1)),
                r3.add(r2),
                r3.add(neg(r2)),
            ],
        }
    }

    /// True when the AABB is at least partially inside (conservative).
    pub fn intersects_aabb(&self, mins: Vec3, maxs: Vec3) -> bool {
        for plane in &self.planes {
            // Most-positive vertex for this plane's normal.
            let p = vec3(
                if plane.x >= 0.0 { maxs.x } else { mins.x },
                if plane.y >= 0.0 { maxs.y } else { mins.y },
                if plane.z >= 0.0 { maxs.z } else { mins.z },
            );
            if plane.dot(vec4(p.x, p.y, p.z, 1.0)) < 0.0 {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mat_mul_identity() {
        let p = Mat4::perspective_gl(1.0, 480.0 / 272.0, 1.0, 100.0);
        let out = p.mul(&Mat4::IDENTITY);
        assert_eq!(p.m, out.m);
    }

    #[test]
    fn look_at_centers_target() {
        let v = Mat4::look_at(vec3(0.0, 10.0, 0.0), Vec3::ZERO, vec3(0.0, 0.0, -1.0));
        let c = v.transform(Vec3::ZERO, 1.0);
        // The look-at target lands on the view -Z axis.
        assert!(c.x.abs() < 1e-5 && c.y.abs() < 1e-5);
        assert!((c.z + 10.0).abs() < 1e-4);
    }

    #[test]
    fn frustum_basics() {
        let vp = Mat4::perspective_gl(1.0, 1.0, 1.0, 100.0).mul(&Mat4::look_at(
            vec3(0.0, 0.0, 10.0),
            Vec3::ZERO,
            Vec3::Y,
        ));
        let f = Frustum::from_clip(&vp);
        assert!(f.intersects_aabb(vec3(-1.0, -1.0, -1.0), vec3(1.0, 1.0, 1.0)));
        assert!(!f.intersects_aabb(vec3(500.0, 500.0, 500.0), vec3(501.0, 501.0, 501.0)));
    }
}
