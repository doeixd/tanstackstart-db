import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    entry: [
      "src/index.ts",
      "src/schema.ts",
      "src/react.ts",
      "src/server.ts",
      "src/testing.ts",
      "src/query-collection.ts",
      "src/local-storage-collection.ts",
      "src/sync-collection.ts",
      "src/pagination.ts",
    ],
    dts: {
      tsgo: true,
    },
    exports: true,
    deps: {
      neverBundle: ["react-dom"],
    },
  },
  test: {
    environment: "jsdom",
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
