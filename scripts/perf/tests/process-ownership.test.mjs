import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = fileURLToPath(new URL("./fixtures/process-ownership.ps1", import.meta.url));
for (const shell of ["powershell.exe", "pwsh.exe"]) {
  test(`process ownership fixtures and read-only CIM check (${shell})`, { skip: process.platform !== "win32" }, context => {
    const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture], {
      encoding: "utf8", windowsHide: true, timeout: 30000,
    });
    if (shell === "pwsh.exe" && result.error?.code === "ENOENT") return context.skip("PowerShell 7 is not installed");
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const summary = JSON.parse(result.stdout.trim());
    assert.equal(summary.count, 31);
    assert.equal(new Set(summary.checks).size, summary.count);
  });
}
