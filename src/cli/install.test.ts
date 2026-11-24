import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stableNodePath } from "./install.ts";

test("Homebrew 的 Node 路径换成升级后依然有效的 opt 路径；不存在时保持原样", () => {
  const prefix = realpathSync(mkdtempSync(join(tmpdir(), "brew-")));
  const cellar = join(prefix, "Cellar", "node@24", "24.16.0", "bin", "node");
  assert.equal(stableNodePath(cellar), cellar);
  mkdirSync(join(prefix, "opt", "node@24", "bin"), { recursive: true });
  writeFileSync(join(prefix, "opt", "node@24", "bin", "node"), "");
  assert.equal(stableNodePath(cellar), join(prefix, "opt", "node@24", "bin", "node"));
  assert.equal(stableNodePath("/Users/me/.nvm/versions/node/v24.16.0/bin/node"), "/Users/me/.nvm/versions/node/v24.16.0/bin/node");
});
