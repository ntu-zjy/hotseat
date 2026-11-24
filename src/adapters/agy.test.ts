import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agyHooksProblems, agyLogParseFailure } from "./agy.ts";

test("agy hooks.json 格式：SessionStart/Stop 扁平，PreToolUse 分组；旧版嵌套格式会被查出来", () => {
  const flat = { hotseat: { SessionStart: [{ type: "command", command: "x" }], Stop: [{ command: "y", timeout: 10 }] } };
  assert.deepEqual(agyHooksProblems(flat), []);
  const nested = { hotseat: { SessionStart: [{ hooks: [{ type: "command", command: "x" }] }], Stop: [{ hooks: [{ command: "y" }] }] } };
  assert.deepEqual(agyHooksProblems(nested), [{ group: "hotseat", event: "SessionStart" }, { group: "hotseat", event: "Stop" }]);
  const other = { ...flat, lint: { PostToolUse: [{ command: "lint" }] }, ok: { enabled: false, PreToolUse: [{ matcher: "run_command", hooks: [{ command: "z" }] }] } };
  assert.deepEqual(agyHooksProblems(other), [{ group: "lint", event: "PostToolUse" }]);
});

test("agy 日志：只报 hooks.json 最后一次修改之后、针对这个文件的解析失败", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-log-")));
  const log = join(dir, "language_server.log");
  const file = "/Users/me/.gemini/config/hooks.json";
  writeFileSync(
    log,
    [
      `ERROR: logging before google.Init: W1124 09:46:28.722256    1373 hooks.go:193] Failed to parse hooks file ${file}: invalid hook "hotseat": command hook must specify 'command'`,
      `ERROR: logging before google.Init: W1124 09:47:00.000001    1374 hooks.go:193] Failed to parse hooks file /w/.agents/hooks.json: bad`,
      "other line",
    ].join("\n"),
  );
  const now = new Date(2026, 10, 24, 10, 0, 0);
  const before = new Date(2026, 10, 24, 9, 40, 0).getTime();
  const after = new Date(2026, 10, 24, 9, 50, 0).getTime();
  assert.match(agyLogParseFailure(log, file, before, now) ?? "", /command hook must specify 'command'/);
  assert.equal(agyLogParseFailure(log, file, after, now), null);
  assert.equal(agyLogParseFailure(join(dir, "missing.log"), file, before, now), null);
});
