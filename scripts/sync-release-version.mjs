import { readFile, writeFile } from "node:fs/promises";

const publicManifest = JSON.parse(await readFile("packages/contracts/package.json", "utf8"));
const runtimeManifest = JSON.parse(await readFile("apps/runtime/package.json", "utf8"));
const version = publicManifest.version;

async function updateJson(path, transform) {
  const value = JSON.parse(await readFile(path, "utf8"));
  transform(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function replace(path, pattern, replacement) {
  const source = await readFile(path, "utf8");
  const updated = source.replace(pattern, replacement);
  if (source === updated) throw new Error(`Release version pattern not found in ${path}`);
  await writeFile(path, updated);
}

function releaseType(previousVersion, nextVersion) {
  const previous = previousVersion.split(".").map(Number);
  const next = nextVersion.split(".").map(Number);

  if (next[0] !== previous[0]) return "Major";
  if (next[1] !== previous[1]) return "Minor";
  return "Patch";
}

async function updateRuntimeChangelog(path, previousVersion, nextVersion) {
  let source;

  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    source = "# @kiri_ikki/thread-runtime\n";
  }

  if (source.includes(`\n## ${nextVersion}\n`)) return;

  const title = "# @kiri_ikki/thread-runtime";
  const existingEntries = source.startsWith(title)
    ? source.slice(title.length).trim()
    : source.trim();
  const entry = [
    `## ${nextVersion}`,
    "",
    `### ${releaseType(previousVersion, nextVersion)} Changes`,
    "",
    `- Synchronize the private Runtime deployment artifact with Thread Platform ${nextVersion}.`,
  ].join("\n");

  await writeFile(
    path,
    `${title}\n\n${entry}${existingEntries ? `\n\n${existingEntries}` : ""}\n`,
  );
}

await updateJson("package.json", (value) => {
  value.version = version;
});
await updateJson("apps/runtime/package.json", (value) => {
  value.version = version;
});
await updateRuntimeChangelog(
  "apps/runtime/CHANGELOG.md",
  runtimeManifest.version,
  version,
);
await updateJson("examples/consumer-starter/web/package.json", (value) => {
  value.dependencies["@kiri_ikki/thread-react"] = version;
});
await replace(".env.example", /^THREAD_PLATFORM_VERSION=.*$/m, `THREAD_PLATFORM_VERSION=${version}`);
await replace("examples/consumer-starter/.env.example", /^THREAD_PLATFORM_VERSION=.*$/m, `THREAD_PLATFORM_VERSION=${version}`);
await replace("docker-compose.yml", /THREAD_PLATFORM_VERSION:-[0-9]+\.[0-9]+\.[0-9]+/, `THREAD_PLATFORM_VERSION:-${version}`);
await replace("examples/consumer-starter/compose.yaml", /THREAD_PLATFORM_VERSION:-[0-9]+\.[0-9]+\.[0-9]+/, `THREAD_PLATFORM_VERSION:-${version}`);
await replace("infra/k8s/charts/thread-platform/Chart.yaml", /^version: .*$/m, `version: ${version}`);
await replace("infra/k8s/charts/thread-platform/Chart.yaml", /^appVersion: .*$/m, `appVersion: "${version}"`);
await replace(
  "infra/k8s/charts/thread-platform/values.yaml",
  /(copilotkit-threads-runtime, tag: ")[^"]+(")/,
  `$1${version}$2`,
);
await replace(
  "docs/CONSUMER_QUICKSTART.md",
  /(copilotkit-threads-runtime:)[0-9]+\.[0-9]+\.[0-9]+/,
  `$1${version}`,
);

console.log(`Synchronized release references to ${version}`);
