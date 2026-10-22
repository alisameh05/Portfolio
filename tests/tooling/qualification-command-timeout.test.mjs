import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { executeQualificationCommand } from "../../scripts/qualification-command.mjs";

test("qualification timeout stops owned descendants and settles independently of inherited output pipes", async () => {
  const root = mkdtempSync(join(tmpdir(), "qualification-tree-"));
  const running = (pid) => {
    try {
      if (process.platform === "linux" && /^\d+ \(.+\) Z /u.test(readFileSync(`/proc/${pid}/stat`, "utf8"))) return false;
      process.kill(pid, 0);
      return true;
    } catch { return false; }
  };
  try {
    writeFileSync(join(root, "descendant.mjs"), `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.argv[2], 'pid'), String(process.pid));
process.stdout.write('descendant-ready\\n');
if (process.platform !== 'win32') process.on('SIGTERM', () => {});
setTimeout(() => { writeFileSync(join(process.argv[2], 'escaped'), 'still running'); process.exit(0); }, 7_000);
`);
    writeFileSync(join(root, "parent.mjs"), `import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
spawn(process.execPath, [join(process.argv[2], 'descendant.mjs'), process.argv[2]], { stdio: ['ignore', 'inherit', 'inherit'] });
if (process.argv[3] === 'exit') {
  const ready = setInterval(() => { if (existsSync(join(process.argv[2], 'pid'))) { clearInterval(ready); process.exit(0); } }, 5);
}
`);
    for (const mode of ["running", "exit"]) {
      rmSync(join(root, "pid"), { force: true });
      rmSync(join(root, "escaped"), { force: true });
      let pid;
      try {
        const began = performance.now();
        const result = await executeQualificationCommand({ entry: process.execPath,
          args: [join(root, "parent.mjs"), root, mode], timeoutMs: 500 });
        const elapsed = performance.now() - began;
        // Windows can close the inherited handles and stop the worker at the
        // parent's natural exit. That genuine early completion needs no timeout.
        if (!(process.platform === "win32" && mode === "exit" && result.status === 0)) {
          assert.equal(result.errorCode, "ETIMEDOUT", result.output);
          assert.equal(result.timedOut, true);
          assert.equal(result.status, 1);
        }
        assert.match(result.output, /descendant-ready/u, "the actual descendant must start before the timeout");
        pid = Number(readFileSync(join(root, "pid"), "utf8"));
        assert.ok(elapsed < 2_500, `${mode}: timeout waited ${Math.round(elapsed)}ms for inherited pipes`);
        assert.equal(running(pid), false, `${mode}: owned descendant must stop before completion`);
        assert.equal(existsSync(join(root, "escaped")), false);
      } finally {
        if (pid === undefined && existsSync(join(root, "pid"))) pid = Number(readFileSync(join(root, "pid"), "utf8"));
        // A failed regression must also leave no fixture worker behind.
        const until = Date.now() + 8_000;
        while (pid && running(pid) && Date.now() < until) await delay(25);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
