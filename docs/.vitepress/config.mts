import { withMermaid } from "vitepress-plugin-mermaid";

// Deployed as a GitHub Pages project site; the base must match the repo name.
export default withMermaid({
  title: "Pocket Voxel",
  description:
    "A Game Boy creature-RPG as a voxelized 3D diorama on a real PSP and PS Vita — one cooked pak, one guest bundle, deterministic to the byte.",
  base: "/pocket-voxel/",
  lastUpdated: true,

  head: [
    [
      "link",
      {
        rel: "icon",
        href: "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🧊</text></svg>",
      },
    ],
    ["meta", { name: "theme-color", content: "#2fbf71" }],
  ],

  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started", activeMatch: "/guide/" },
      { text: "Reference", link: "/reference/cli", activeMatch: "/reference/" },
      { text: "Design Record", link: "/VOXEL" },
    ],

    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting Started", link: "/guide/getting-started" },
          { text: "Architecture", link: "/guide/architecture" },
          { text: "The Asset Pipeline", link: "/guide/pipeline" },
          { text: "The Quality Ladder", link: "/guide/quality-ladder" },
          { text: "Running on PSP", link: "/guide/psp" },
          { text: "Running on PS Vita", link: "/guide/vita" },
          { text: "Testing & Determinism", link: "/guide/testing" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI — tools/voxel.ts", link: "/reference/cli" },
          { text: "The Voxel Surface", link: "/reference/surface" },
          { text: "Data & Formats", link: "/reference/formats" },
          { text: "Glossary", link: "/reference/glossary" },
        ],
      },
      {
        text: "Project",
        items: [
          { text: "Contributing", link: "/contributing" },
          { text: "Design Record (VOXEL.md)", link: "/VOXEL" },
        ],
      },
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/pocket-stack/pocket-voxel" },
    ],

    editLink: {
      pattern:
        "https://github.com/pocket-stack/pocket-voxel/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    search: { provider: "local" },

    outline: { level: [2, 3] },

    footer: {
      message:
        "MIT Licensed. The ROM, and everything derived from it, stays yours and stays local.",
      copyright: "© Pocket Voxel contributors",
    },
  },

  // Mermaid renders client-side; fixed light node fills + dark node text stay
  // readable on both themes, and edge labels are re-themed in custom.css.
  mermaid: {
    theme: "base",
    themeVariables: {
      primaryColor: "#ecfdf4",
      primaryTextColor: "#14261d",
      primaryBorderColor: "#2fbf71",
      lineColor: "#94a3b8",
      edgeLabelBackground: "transparent",
      fontSize: "14px",
    },
    fontFamily:
      "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
});
