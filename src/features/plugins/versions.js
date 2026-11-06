export function parseSemver(v) {
  const match = String(v || "").trim().match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < count; i++) {
    if (left.prerelease[i] === undefined) return -1;
    if (right.prerelease[i] === undefined) return 1;
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function isUpdateAvailable(installedV, latestV) {
  return compareSemver(installedV, latestV) === -1;
}

export function compareVersionsDesc(a, b) {
  const result = compareSemver(a, b);
  return result === null ? 0 : -result;
}

export function eligibleUpdateIds(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.hasUpdate && entry?.compatible && !entry?.bundled)
    .map((entry) => entry.id);
}
