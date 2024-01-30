import { build, emptyDir } from "https://deno.land/x/dnt@0.39.0/mod.ts";

const outDir = "./dist";

await emptyDir(outDir);

await build({
  entryPoints: ["./src/index.ts"],
  outDir,
  shims: { deno: true },
  package: {
    name: "abstract-bot-api",
    version: Deno.args[0],
    description: "",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/uriva/abstract-bot-api.git",
    },
    bugs: { url: "https://github.com/uriva/abstract-bot-api/issues" },
    devDependencies: {
      "@types/ws": "^8.5.10",
    },
  },
  importMap: "deno.json",
  postBuild() {
    Deno.copyFileSync("./LICENSE", outDir + "/LICENSE");
    Deno.copyFileSync("./README.md", outDir + "/README.md");
  },
});
