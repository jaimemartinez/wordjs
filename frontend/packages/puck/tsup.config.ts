import fs from "fs";
import path from "path";
import postcss from "postcss";
import postcssModules from "postcss-modules";
import { defineConfig, type Options } from "tsup";

// Vendored, inlined build config for the WordJS Puck fork.
//
// This is Puck v0.20.2's own build pipeline, copied verbatim from the upstream monorepo's
// internal `tsup-config` package (which we intentionally did NOT vendor as a separate package —
// there is exactly one consumer, so it lives here). The only change from upstream is the
// self-reference in `external`: "@measured/puck" -> "@wordjs/puck".
//
// The custom `css-module` esbuild plugin runs every `*.module.css` through postcss-modules to
// produce hashed, locally-scoped class names AND emit the compiled CSS into the bundle — the same
// mechanism Next.js applies to app CSS modules, reproduced here so the built dist is byte-compatible
// with what the app consumed from @measured/puck before the fork. Plain `.css` files are handled by
// esbuild's default css loader. dnd-kit / react stay external (real runtime deps); lucide-react and
// css-box-model are devDeps and therefore get bundled in.
const config: Options = {
  dts: true,
  format: ["cjs", "esm"],
  inject: ["./react-import.js"],
  external: [
    "react",
    "react-dom",
    "@wordjs/puck",
    "@dnd-kit/react",
    "@dnd-kit/dom",
    "@dnd-kit/abstract",
    "@dnd-kit/state",
    "@dnd-kit/geometry",
    "@dnd-kit/utilities",
  ],
  esbuildPlugins: [
    {
      name: "css-module",
      setup(build): void {
        build.onResolve(
          { filter: /\.module\.css$/, namespace: "file" },
          (args) => ({
            path: `${path.join(args.resolveDir, args.path)}#css-module`,
            namespace: "css-module",
            pluginData: {
              pathDir: path.join(args.resolveDir, args.path),
            },
          })
        );
        build.onLoad(
          { filter: /#css-module$/, namespace: "css-module" },
          async (args) => {
            const { pluginData } = args as {
              pluginData: { pathDir: string };
            };

            const source = fs.readFileSync(pluginData.pathDir, "utf8");

            let cssModule = {};
            const result = await postcss([
              postcssModules({
                getJSON(_, json) {
                  cssModule = json;
                },
              }),
            ]).process(source, { from: pluginData.pathDir });

            return {
              pluginData: { css: result.css },
              contents: `import "${
                pluginData.pathDir
              }"; export default ${JSON.stringify(cssModule)}`,
            };
          }
        );
        build.onResolve(
          { filter: /\.module\.css$/, namespace: "css-module" },
          (args) => ({
            path: path.join(args.resolveDir, args.path, "#css-module-data"),
            namespace: "css-module",
            pluginData: args.pluginData as { css: string },
          })
        );
        build.onLoad(
          { filter: /#css-module-data$/, namespace: "css-module" },
          (args) => ({
            contents: (args.pluginData as { css: string }).css,
            loader: "css",
          })
        );
      },
    },
  ],
};

export default defineConfig({ ...config });
