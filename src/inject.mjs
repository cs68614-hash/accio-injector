import asar from "@electron/asar";
import plist from "plist";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const repoRoot = resolve(projectRoot, "..");

const sourceApp = resolveArg("--source") ?? "/Applications/Accio.app";
const targetApp = resolveArg("--target") ?? "/private/tmp/Accio-injected.app";
const userRoot = resolveArg("--user-root")
  ?? join(homedir(), "Library", "Application Support", "accio-injector-poc");
const keepExisting = process.argv.includes("--keep-existing");
const skipLaunch = process.argv.includes("--skip-launch");

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

async function main() {
  const contents = join(targetApp, "Contents");
  const resources = join(contents, "Resources");
  const asarPath = join(resources, "app.asar");
  const plistPath = join(contents, "Info.plist");
  const frameworkPath = join(
    contents,
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Electron Framework",
  );

  console.log(`source: ${sourceApp}`);
  console.log(`target: ${targetApp}`);
  console.log(`userRoot: ${userRoot}`);

  if (!existsSync(sourceApp)) throw new Error(`source app not found: ${sourceApp}`);
  if (!keepExisting) {
    rmSync(targetApp, { recursive: true, force: true });
    execFileSync("ditto", [sourceApp, targetApp], { stdio: "inherit" });
  }

  mkdirSync(join(userRoot, "runtime"), { recursive: true });
  mkdirSync(join(userRoot, "log"), { recursive: true });
  cpSync(join(projectRoot, "runtime", "main.cjs"), join(userRoot, "runtime", "main.cjs"));
  cpSync(join(projectRoot, "runtime", "preload.cjs"), join(userRoot, "runtime", "preload.cjs"));
  const configPath = join(userRoot, "config.json");
  if (!existsSync(configPath) && existsSync(join(projectRoot, "config.example.json"))) {
    cpSync(join(projectRoot, "config.example.json"), configPath);
    console.log(`created default config: ${configPath}`);
  }

  const originalHash = readHeaderHash(asarPath).headerHash;
  console.log(`original asar header hash: ${originalHash}`);

  await patchAsar(asarPath, (dir) => {
    const packagePath = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    const originalMain = pkg.__accioInjector?.originalMain || pkg.main;
    if (!originalMain) throw new Error("app.asar package.json has no main field");

    pkg.__accioInjector = {
      originalMain,
      userRoot,
      loader: "accio-injector-loader.cjs",
      patchedAt: new Date().toISOString(),
    };
    pkg.main = "accio-injector-loader.cjs";
    writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
    cpSync(join(projectRoot, "runtime", "loader.cjs"), join(dir, "accio-injector-loader.cjs"));
    console.log(`patched package.json main: ${originalMain} -> ${pkg.main}`);
  });

  const patchedHash = readHeaderHash(asarPath).headerHash;
  console.log(`patched asar header hash: ${patchedHash}`);
  updateAsarIntegrity(plistPath, patchedHash);
  console.log("updated ElectronAsarIntegrity");

  const fuseResult = writeFuse(frameworkPath, "EnableEmbeddedAsarIntegrityValidation", "off");
  console.log(
    `fuse EnableEmbeddedAsarIntegrityValidation: ${fuseResult.from} -> ${fuseResult.to}`,
  );

  adHocSign(targetApp);
  console.log("ad-hoc signed copied app");

  if (!skipLaunch) {
    rmSync(join(userRoot, "log"), { recursive: true, force: true });
    mkdirSync(join(userRoot, "log"), { recursive: true });
    console.log("launching copied app...");
    spawnSync("/usr/bin/open", ["-n", targetApp], { stdio: "inherit" });
  }

  console.log("done");
  console.log(`logs: ${join(userRoot, "log")}`);
  console.log(`verify: cd ${projectRoot} && npm run verify`);
}

function resolveArg(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function readHeaderHash(asarPath) {
  const raw = asar.getRawHeader(asarPath);
  const headerHash = createHash("sha256").update(raw.headerString).digest("hex");
  return { headerHash, header: raw.header };
}

async function patchAsar(asarPath, mutate) {
  const work = mkdtempSync(join(tmpdir(), "accio-asar-"));
  const src = join(work, "src");
  const out = join(work, "app.asar");
  const resourcesDir = dirname(asarPath);
  const appSource = join(resourcesDir, "app_source");
  const unpack = collectExistingUnpackGlob(`${asarPath}.unpacked`) ?? collectUnpackGlob(asarPath);

  try {
    if (existsSync(appSource)) {
      cpSync(appSource, src, { recursive: true });
      restoreMissingFilesFromAsar(asarPath, src);
    } else {
      asar.extractAll(asarPath, src);
    }
    await mutate(src);
    await asar.createPackageWithOptions(src, out, {
      globOptions: { dot: true },
      ...(unpack ? { unpack } : {}),
    });
    const staging = `${asarPath}.accio-injector-new`;
    cpSync(out, staging);
    renameSync(staging, asarPath);
    const generatedUnpacked = `${out}.unpacked`;
    if (existsSync(generatedUnpacked)) {
      rmSync(`${asarPath}.unpacked`, { recursive: true, force: true });
      cpSync(generatedUnpacked, `${asarPath}.unpacked`, { recursive: true });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function collectExistingUnpackGlob(unpackedDir) {
  if (!existsSync(unpackedDir)) return undefined;
  const paths = [];
  collectFiles(unpackedDir, "", paths);
  if (paths.length === 0) return undefined;
  const patterns = paths.map((path) => `**/${path}`);
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}

function collectFiles(root, prefix, out) {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) collectFiles(root, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

function collectUnpackGlob(asarPath) {
  if (!existsSync(`${asarPath}.unpacked`)) return undefined;
  const raw = asar.getRawHeader(asarPath);
  const paths = [];
  walkAsarHeader(raw.header, "", paths);
  if (paths.length === 0) return undefined;
  const patterns = paths.map((path) => `**${path}`);
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}

function walkAsarHeader(node, prefix, out) {
  const files = node?.files;
  if (!files) return;
  for (const [name, value] of Object.entries(files)) {
    const path = `${prefix}/${name}`;
    if (value.files) walkAsarHeader(value, path, out);
    else if (value.unpacked) out.push(path);
  }
}

function restoreMissingFilesFromAsar(asarPath, targetDir) {
  const raw = asar.getRawHeader(asarPath);
  const unpackedRoot = `${asarPath}.unpacked`;
  const restored = { inline: 0, unpacked: 0, skipped: 0 };
  restoreMissingFilesFromAsarNode(raw.header, "", asarPath, unpackedRoot, targetDir, restored);
  console.log(
    `restored missing files from original asar: inline=${restored.inline} unpacked=${restored.unpacked} skipped=${restored.skipped}`,
  );
}

function restoreMissingFilesFromAsarNode(node, prefix, asarPath, unpackedRoot, targetDir, restored) {
  const files = node?.files;
  if (!files) return;
  for (const [name, value] of Object.entries(files)) {
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const targetPath = join(targetDir, archivePath);
    if (value.files) {
      restoreMissingFilesFromAsarNode(value, archivePath, asarPath, unpackedRoot, targetDir, restored);
      continue;
    }
    if (existsSync(targetPath)) continue;
    mkdirSync(dirname(targetPath), { recursive: true });
    try {
      if (value.unpacked) {
        const unpackedPath = join(unpackedRoot, archivePath);
        if (!existsSync(unpackedPath)) {
          restored.skipped++;
          continue;
        }
        cpSync(unpackedPath, targetPath);
        restored.unpacked++;
      } else {
        writeFileSync(targetPath, asar.extractFile(asarPath, archivePath));
        restored.inline++;
      }
    } catch {
      restored.skipped++;
    }
  }
}

function updateAsarIntegrity(plistPath, hash) {
  const parsed = plist.parse(readFileSync(plistPath, "utf8"));
  parsed.ElectronAsarIntegrity = {
    ...(parsed.ElectronAsarIntegrity || {}),
    "Resources/app.asar": {
      algorithm: "SHA256",
      hash,
    },
  };
  writeFileSync(plistPath, plist.build(parsed));
}

const fuseNames = {
  RunAsNode: 0,
  EnableCookieEncryption: 1,
  EnableNodeOptionsEnvironmentVariable: 2,
  EnableNodeCliInspectArguments: 3,
  EnableEmbeddedAsarIntegrityValidation: 4,
  OnlyLoadAppFromAsar: 5,
  LoadBrowserProcessSpecificV8Snapshot: 6,
  GrantFileProtocolExtraPrivileges: 7,
};
const fuseBytes = {
  off: 0x30,
  on: 0x31,
  removed: 0x32,
  inherit: 0x33,
};
const byteToFuse = Object.fromEntries(Object.entries(fuseBytes).map(([key, value]) => [value, key]));
const fuseSentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");

function writeFuse(binaryPath, name, value) {
  const index = fuseNames[name];
  if (index === undefined) throw new Error(`unknown fuse: ${name}`);
  const buf = readFileSync(binaryPath);
  const sentinelOffset = buf.indexOf(fuseSentinel);
  if (sentinelOffset < 0) throw new Error(`fuse sentinel not found: ${binaryPath}`);
  const headerOffset = sentinelOffset + fuseSentinel.length;
  const schemaVersion = buf[headerOffset];
  const count = buf[headerOffset + 1];
  const fuseOffset = headerOffset + 2;
  if (schemaVersion !== 1) throw new Error(`unsupported fuse schema: ${schemaVersion}`);
  if (index >= count) throw new Error(`fuse ${name} not present; count=${count}`);

  const from = byteToFuse[buf[fuseOffset + index]] || `0x${buf[fuseOffset + index].toString(16)}`;
  const to = value;
  if (from === value) return { from, to };

  buf[fuseOffset + index] = fuseBytes[value];
  const mode = statSync(binaryPath).mode;
  writeFileSync(binaryPath, buf);
  chmodSync(binaryPath, mode);
  return { from, to };
}

function adHocSign(appPath) {
  walkAndSignMachO(join(appPath, "Contents", "Resources", "app.asar.unpacked"));
  const result = spawnSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", appPath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`codesign failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

const machoMagics = new Set([
  0xfeedface,
  0xfeedfacf,
  0xcafebabe,
  0xcffaedfe,
  0xcefaedfe,
]);

function walkAndSignMachO(root) {
  if (!existsSync(root)) return;
  const failures = [];
  walk(root, (file) => {
    if (!isMachO(file)) return;
    const result = spawnSync(
      "codesign",
      ["--force", "--sign", "-", "--preserve-metadata=entitlements,flags", file],
      { encoding: "utf8" },
    );
    if (result.status !== 0) failures.push(`${file}: ${result.stderr || result.stdout}`);
  });
  if (failures.length) {
    throw new Error(`failed to sign ${failures.length} Mach-O file(s):\n${failures.join("\n")}`);
  }
}

function walk(current, visit) {
  for (const entry of readdirSync(current)) {
    const full = join(current, entry);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walk(full, visit);
    else if (stat.isFile()) visit(full);
  }
}

function isMachO(file) {
  try {
    const buf = readFileSync(file);
    if (buf.length < 4) return false;
    return machoMagics.has(buf.readUInt32BE(0));
  } catch {
    return false;
  }
}
