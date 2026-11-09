import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Docsworth keeps per-user state (audit logs, mirror ownership records) under
// $XDG_STATE_HOME. Tests must never touch the real one, so each worker gets its own.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "docsworth-test-state-"));
