/* eslint-disable */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const pkg = require("./package.json");
const meta = pkg.__accioInjector || {};
const originalMain = meta.originalMain;
const userRoot = meta.userRoot;

function appendLog(line) {
  try {
    const logDir = path.join(userRoot || "", "log");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "loader.log"), `[${new Date().toISOString()}] ${line}\n`);
  } catch (error) {
    try {
      process.stderr.write(`[accio-injector] ${line} (${error && error.message || error})\n`);
    } catch {}
  }
}

try {
  if (!originalMain) throw new Error("missing __accioInjector.originalMain");
  if (!userRoot) throw new Error("missing __accioInjector.userRoot");

  const runtimeMain = path.join(userRoot, "runtime", "main.cjs");
  process.env.ACCIO_INJECTOR_USER_ROOT = userRoot;
  process.env.ACCIO_INJECTOR_RUNTIME = path.dirname(runtimeMain);
  appendLog(`loader reached; originalMain=${originalMain}; runtime=${runtimeMain}`);

  if (fs.existsSync(runtimeMain)) {
    require(runtimeMain);
  } else {
    appendLog(`runtime missing at ${runtimeMain}; continuing without injection`);
  }
} catch (error) {
  appendLog(`loader failed: ${error && error.stack || error}`);
}

require("./" + originalMain);
