# Pocket Voxel web third-party notices

The browser distribution includes the following third-party runtime code.
Versions are pinned by `bun.lock` and `Cargo.lock`.

| Component | Version | Copyright / authors | License used by this distribution |
| --- | --- | --- | --- |
| [three.js](https://github.com/mrdoob/three.js) | 0.185.1 | Copyright © 2010–2026 three.js authors | [MIT](./three-LICENSE.txt) |
| [wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen) | 0.2.126 | The wasm-bindgen Developers | [MIT](./wasm-bindgen-LICENSE-MIT.txt) |
| [cfg-if](https://github.com/rust-lang/cfg-if) | 1.0.4 | Alex Crichton | [MIT](./cfg-if-LICENSE-MIT.txt) |
| [once_cell](https://github.com/matklad/once_cell) | 1.21.4 | Aleksey Kladov | [MIT](./once_cell-LICENSE-MIT.txt) |
| [self_cell](https://github.com/Voultapher/self_cell) | 1.3.0 | Lukas Bergdoll | [Apache-2.0](./self_cell-LICENSE-APACHE.txt) |
| [miniz_oxide](https://github.com/Frommi/miniz_oxide) | 0.8.9 | miniz_oxide contributors | [MIT](./miniz_oxide-LICENSE-MIT.md) |
| [adler2](https://github.com/oyvindln/adler2) | 2.0.1 | adler2 contributors | [MIT](./adler2-LICENSE-MIT.txt) |
| [unicode-ident](https://github.com/dtolnay/unicode-ident) | 1.0.24 | David Tolnay and Unicode, Inc. | [MIT](./unicode-ident-LICENSE-MIT.txt) and [Unicode-3.0](./unicode-ident-LICENSE-UNICODE.txt) |

The optional PSP and PS Vita downloads are assembled from ROM-independent
native host templates built from this repository. Their principal embedded
runtime components include [PocketJS](./pocketjs-LICENSE.txt),
[QuickJS](./quickjs-LICENSE.txt), [rust-psp](./rust-psp-LICENSE.txt),
[vita2d](./vita2d-LICENSE.txt), and [vitasdk-sys](./vitasdk-sys-LICENSE-MIT.txt).
Exact host revisions and template hashes are pinned in
[`platform/manifest.json`](../../platform/manifest.json).

The Game Boy stage model is distributed separately under CC BY 4.0; see the
[model attribution](../../assets/game-boy/ATTRIBUTION.md). Reference-data
licenses are also present in the parent `third-party` directory.
