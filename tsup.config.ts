import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/md.ts",
    mdview: "src/mdview.ts",
    config: "src/config.ts",
    "markdown/parse": "src/markdown/parse.ts",
    "markdown/render": "src/markdown/render.ts",
    "ui/search": "src/ui/search.ts",
    "ui/selection": "src/ui/selection.ts",
    "ui/clipboard": "src/ui/clipboard.ts",
    "ui/content": "src/ui/content.ts",
    "ui/statusbar": "src/ui/statusbar.ts",
    "ui/language": "src/ui/language.ts",
    "ui/links": "src/ui/links.ts",
    i18n: "src/i18n.ts",
    theme: "src/theme.ts",
  },
  format: ["cjs"],
  target: "node18",
  platform: "node",
  bundle: true,
  clean: true,
  dts: true,
  sourcemap: true,
  minify: false,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
