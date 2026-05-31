import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const userRoot = process.env.ACCIO_INJECTOR_USER_ROOT
  || resolveArg("--user-root")
  || join(process.env.HOME || "", "Library", "Application Support", "accio-injector-poc");

for (const name of ["loader.log", "main.log"]) {
  const file = join(userRoot, "log", name);
  console.log(`\n== ${file} ==`);
  if (!existsSync(file)) {
    console.log("(missing)");
    continue;
  }
  const text = readFileSync(file, "utf8");
  console.log(text.split("\n").slice(-40).join("\n"));
}

function resolveArg(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
