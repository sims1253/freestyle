#!/usr/bin/env node

/**
 * Download pre-built parakeet-cli binaries from GitHub releases.
 *
 * Usage:
 *   node scripts/download-parakeet-cpp.mjs              # dev: ~/.cache/freestyle/parakeet-bin/
 *   node scripts/download-parakeet-cpp.mjs --resources   # CI:  resources/parakeet/{platform}-{arch}/
 *   node scripts/download-parakeet-cpp.mjs --backend cuda  # explicit backend override
 *
 * Downloads from https://github.com/mudler/parakeet.cpp/releases
 *
 * By default the platform-best backend is fetched (Vulkan on Win/Linux x64,
 * Metal on Apple Silicon, CPU elsewhere). Pass --backend <cpu|vulkan|cuda|metal>
 * to pick a specific build. CUDA builds additionally pull the cudart bundle.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const RELEASE_TAG = "v0.2.0";
const RELEASE_BASE = `https://github.com/mudler/parakeet.cpp/releases/download/${RELEASE_TAG}`;
const CACHE_DIR = join(homedir(), ".cache", "freestyle", "parakeet-bin");
const BACKEND_MARKER = ".installed-backend";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ELECTRON_ROOT = join(__dirname, "..");
const RESOURCES_DIR = join(
  ELECTRON_ROOT,
  "resources",
  "parakeet",
  `${process.platform}-${process.arch}`,
);

// ---------------------------------------------------------------------------
// Backend → release asset mapping (mirrors apps/server/src/lib/parakeet/backends.ts)
// ---------------------------------------------------------------------------

const PLATFORM_DEFAULT = {
  "darwin-arm64": "metal",
  "darwin-x64": "cpu",
  "linux-x64": "vulkan",
  "linux-arm64": "cpu",
  "win32-x64": "vulkan",
};

const PLATFORM_BACKENDS = {
  "darwin-arm64": ["metal", "cpu"],
  "darwin-x64": ["cpu"],
  "linux-x64": ["vulkan", "cuda", "cpu"],
  "linux-arm64": ["cpu"],
  "win32-x64": ["vulkan", "cuda", "cpu"],
};

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function getRequestedBackend() {
  const idx = process.argv.indexOf("--backend");
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return "auto";
}

function resolveBackend(preference) {
  const key = platformKey();
  if (preference === "auto" || !preference) {
    return PLATFORM_DEFAULT[key] ?? "cpu";
  }
  const supported = PLATFORM_BACKENDS[key] ?? [];
  return supported.includes(preference)
    ? preference
    : (PLATFORM_DEFAULT[key] ?? "cpu");
}

function getAssetForBackend(backend) {
  const platform = process.platform;
  const arch = process.arch;
  const v = RELEASE_TAG;

  const specs = {
    "darwin-arm64": {
      metal: { path: "macos-metal-arm64", ext: ".tar.gz" },
    },
    "darwin-x64": {
      cpu: { path: "macos-cpu-x64", ext: ".tar.gz" },
    },
    "linux-x64": {
      vulkan: { path: "linux-vulkan-x64", ext: ".tar.gz" },
      cuda: { path: "linux-cuda-x64", ext: ".tar.gz" },
      cpu: { path: "linux-cpu-x64", ext: ".tar.gz" },
    },
    "linux-arm64": {
      cpu: { path: "linux-cpu-arm64", ext: ".tar.gz" },
    },
    "win32-x64": {
      vulkan: { path: "win-vulkan-x64", ext: ".zip" },
      cuda: { path: "win-cuda-x64", ext: ".zip" },
      cpu: { path: "win-cpu-x64", ext: ".zip" },
    },
  };

  const spec = specs[platformKey()]?.[backend];
  if (!spec) return null;

  const archiveName = `parakeet-${v}-bin-${spec.path}${spec.ext}`;
  const asset = {
    url: `${RELEASE_BASE}/${archiveName}`,
    archiveName,
    ext: spec.ext,
    cudart: null,
  };

  // CUDA on Windows needs the cudart DLL bundle; Linux bundles it inline.
  if (backend === "cuda" && platform === "win32" && arch === "x64") {
    const cudartName = "cudart-parakeet-bin-win-cuda-x64.zip";
    asset.cudart = {
      url: `${RELEASE_BASE}/${cudartName}`,
      archiveName: cudartName,
    };
  }
  return asset;
}

// ---------------------------------------------------------------------------
// Output dir + existing-binary check
// ---------------------------------------------------------------------------

function getOutputDir() {
  return process.argv.includes("--resources") ? RESOURCES_DIR : CACHE_DIR;
}

function getCliName() {
  return process.platform === "win32" ? "parakeet-cli.exe" : "parakeet-cli";
}

// ---------------------------------------------------------------------------
// Download + extract
// ---------------------------------------------------------------------------

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

async function downloadAndExtract(asset, outDir) {
  const isZip = asset.archiveName.endsWith(".zip");
  const archivePath = join(outDir, asset.archiveName.split("/").pop());
  const extractDir = join(outDir, "parakeet-extract");

  console.log(`Downloading ${asset.url}...`);
  await fetchToFile(asset.url, archivePath);

  if (existsSync(extractDir))
    rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  console.log(`Extracting ${asset.archiveName}...`);
  if (isZip) {
    if (process.platform === "win32") {
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Add-Type -Assembly System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${archivePath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')`,
        ],
        { stdio: "inherit" },
      );
    } else {
      execFileSync("tar", ["xf", archivePath, "-C", extractDir], {
        stdio: "inherit",
      });
    }
  } else {
    execFileSync(
      "tar",
      ["xzf", archivePath, "-C", extractDir, "--strip-components=1"],
      {
        stdio: "inherit",
      },
    );
  }

  function copyAllSync(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const srcPath = join(dir, entry.name);
      const destPath = join(outDir, entry.name);
      if (entry.isDirectory()) {
        copyAllSync(srcPath);
      } else {
        copyFileSync(srcPath, destPath);
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

  // macOS: add rpath so binaries find bundled dylibs
  if (process.platform === "darwin") {
    const binPath = join(outDir, "parakeet-cli");
    if (existsSync(binPath)) {
      try {
        execFileSync("install_name_tool", ["-add_rpath", outDir, binPath], {
          stdio: "pipe",
        });
      } catch {}
    }
  }

  // Cleanup archive + extraction dir
  try {
    unlinkSync(archivePath);
    rmSync(extractDir, { recursive: true, force: true });
  } catch {}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const outDir = getOutputDir();
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const requested = getRequestedBackend();
  const resolved = resolveBackend(requested);
  const cli = getCliName();

  console.log(
    `Requested backend: ${requested} → resolved: ${resolved} (${platformKey()})`,
  );

  // If the binary already exists and the marker matches, nothing to do.
  const markerPath = join(outDir, BACKEND_MARKER);
  let installedBackend = null;
  try {
    const raw = readFileSync(markerPath, "utf8").trim();
    if (["cpu", "vulkan", "cuda", "metal"].includes(raw))
      installedBackend = raw;
  } catch {}
  if (existsSync(join(outDir, cli)) && installedBackend === resolved) {
    console.log(`parakeet-cli (${resolved}) already exists at ${outDir}`);
    return;
  }

  const asset = getAssetForBackend(resolved);
  if (!asset) {
    console.error(
      `No pre-built binary for backend=${resolved} on ${platformKey()}`,
    );
    process.exit(1);
  }

  await downloadAndExtract(asset, outDir);

  // CUDA on Windows: also fetch the cudart DLL bundle.
  if (asset.cudart) {
    try {
      console.log("Downloading CUDA runtime libraries...");
      await downloadAndExtract(
        { url: asset.cudart.url, archiveName: asset.cudart.archiveName },
        outDir,
      );
    } catch (err) {
      console.warn(`Failed to download CUDA runtime: ${err.message}`);
    }
  }

  if (!existsSync(join(outDir, cli))) {
    console.error(`parakeet-cli not found after extraction at ${outDir}`);
    process.exit(1);
  }

  // Record which backend was installed so runtime upgrades can skip re-downloads.
  try {
    writeFileSync(markerPath, resolved, "utf8");
  } catch {}

  console.log(`Done. parakeet-cli (${resolved}) installed at ${outDir}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
