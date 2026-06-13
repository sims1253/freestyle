#!/usr/bin/env node

/**
 * Download pre-built parakeet-cli binaries from GitHub releases.
 *
 * Usage:
 *   node scripts/download-parakeet-cpp.mjs              # dev: ~/.cache/freestyle/parakeet-bin/
 *   node scripts/download-parakeet-cpp.mjs --resources   # CI:  resources/parakeet/{platform}-{arch}/
 *
 * Downloads from https://github.com/mudler/parakeet.cpp/releases
 * Tries CUDA build first (if available), then Vulkan, then CPU.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const RELEASE_TAG = "v0.2.0";
const RELEASE_BASE = `https://github.com/mudler/parakeet.cpp/releases/download/${RELEASE_TAG}`;
const CACHE_DIR = join(homedir(), ".cache", "freestyle", "parakeet-bin");

const __dirname = dirname(fileURLToPath(import.meta.url));
const ELECTRON_ROOT = join(__dirname, "..");
const RESOURCES_DIR = join(
  ELECTRON_ROOT,
  "resources",
  "parakeet",
  `${process.platform}-${process.arch}`,
);

function getOutputDir() {
  return process.argv.includes("--resources") ? RESOURCES_DIR : CACHE_DIR;
}

function getArchiveCandidates() {
  const platform = process.platform;
  const arch = process.arch;
  const v = RELEASE_TAG;
  const candidates = [];

  if (platform === "win32" && arch === "x64") {
    candidates.push(`${RELEASE_BASE}/parakeet-${v}-bin-win-cuda-x64.zip`);
    candidates.push(`${RELEASE_BASE}/parakeet-${v}-bin-win-vulkan-x64.zip`);
    candidates.push(`${RELEASE_BASE}/parakeet-${v}-bin-win-cpu-x64.zip`);
  } else if (platform === "darwin" && arch === "arm64") {
    candidates.push(`${RELEASE_BASE}/parakeet-${v}-bin-macos-metal-arm64.tar.gz`);
  } else if (platform === "darwin" && arch === "x64") {
    candidates.push(`${RELEASE_BASE}/parakeet-${v}-bin-macos-cpu-x64.tar.gz`);
  } else if (platform === "linux" && arch === "x64") {
    candidates.push(`${RELEASE_BASE}/parakeet-${v}-bin-linux-cuda-x64.tar.gz`);
    candidates.push(`${RELEASE_BASE}/parakeet-${v}-bin-linux-vulkan-x64.tar.gz`);
    candidates.push(`${RELEASE_BASE}/parakeet-${v}-bin-linux-cpu-x64.tar.gz`);
  } else if (platform === "linux" && arch === "arm64") {
    candidates.push(`${RELEASE_BASE}/parakeet-${v}-bin-linux-cpu-arm64.tar.gz`);
  }
  return candidates;
}

function getCudartUrl(mainUrl) {
  if (mainUrl.includes("-win-cuda-x64")) {
    return `${RELEASE_BASE}/cudart-parakeet-bin-win-cuda-x64.zip`;
  }
  if (mainUrl.includes("-linux-cuda-x64")) {
    return `${RELEASE_BASE}/cudart-parakeet-bin-linux-cuda-x64.tar.gz`;
  }
  return null;
}

async function fetchToFile(url, dest) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const fileStream = createWriteStream(dest);
  const reader = res.body.getReader();
  const nodeStream = new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        this.push(Buffer.from(value));
      } catch (err) {
        this.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
  await pipeline(nodeStream, fileStream);
}

async function downloadAndExtract(url, outDir) {
  const isZip = url.endsWith(".zip");
  const archiveName = url.split("/").pop();
  const archivePath = join(outDir, archiveName);
  const extractDir = join(outDir, "parakeet-extract");

  console.log(`Downloading ${url}...`);
  await fetchToFile(url, archivePath);

  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  console.log(`Extracting ${archiveName}...`);
  if (isZip) {
    if (process.platform === "win32") {
      execFileSync("powershell", [
        "-NoProfile", "-Command",
        `Add-Type -Assembly System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${archivePath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')`
      ], { stdio: "inherit" });
    } else {
      execFileSync("tar", ["xf", archivePath, "-C", extractDir], { stdio: "inherit" });
    }
  } else {
    execFileSync("tar", ["xzf", archivePath, "-C", extractDir, "--strip-components=1"], {
      stdio: "inherit",
    });
  }

  const fs = await import("node:fs");
  function copyAllSync(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const srcPath = join(dir, entry.name);
      const destPath = join(outDir, entry.name);
      if (entry.isDirectory()) {
        copyAllSync(srcPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
        if (
          entry.name.endsWith(".exe") ||
          entry.name === "parakeet-cli" ||
          entry.name.endsWith(".dll") ||
          entry.name.endsWith(".dylib") ||
          /\.so(\.\d+)*$/.test(entry.name)
        ) {
          if (process.platform !== "win32") chmodSync(destPath, 0o755);
        }
      }
    }
  }
  copyAllSync(extractDir);

  // Cleanup
  try {
    fs.unlinkSync(archivePath);
    rmSync(extractDir, { recursive: true, force: true });
  } catch {}
}

async function main() {
  const outDir = getOutputDir();
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const cli = process.platform === "win32" ? "parakeet-cli.exe" : "parakeet-cli";
  if (existsSync(join(outDir, cli))) {
    console.log(`parakeet-cli already exists at ${outDir}`);
    return;
  }

  const candidates = getArchiveCandidates();
  if (candidates.length === 0) {
    console.error(`No pre-built binaries for platform=${process.platform} arch=${process.arch}`);
    process.exit(1);
  }

  let lastError;
  for (const url of candidates) {
    try {
      await downloadAndExtract(url, outDir);
      if (existsSync(join(outDir, cli))) {
        const cudartUrl = getCudartUrl(url);
        if (cudartUrl) {
          try {
            console.log(`Downloading CUDA runtime libraries...`);
            await downloadAndExtract(cudartUrl, outDir);
          } catch (err) {
            console.warn(`Failed to download CUDA runtime: ${err.message}`);
          }
        }
        console.log(`Done. parakeet-cli installed at ${outDir}`);
        return;
      }
      console.warn(`Downloaded from ${url} but parakeet-cli not found, trying next...`);
    } catch (err) {
      lastError = err;
      console.warn(`Failed to download from ${url}: ${err.message}`);
    }
  }

  console.error(`Failed to download parakeet-cli from any source.${lastError ? ` Last error: ${lastError.message}` : ""}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
