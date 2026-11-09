import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// As in core's tests: Docsworth's per-user state goes to a temporary directory, never the real one.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "docsworth-web-test-state-"));
// Core's test helpers read examples/acme from the repository root, as core's tests run there.
process.chdir(process.env.DOCSWORTH_REPO_ROOT!);
