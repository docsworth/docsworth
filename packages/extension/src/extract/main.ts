// capture.js's entry: it defines the one function capture.ts calls, in the extension's
// isolated world, where the page's scripts can't reach or replace it. Injecting it again (a
// second capture in the same tab) defines it again, the same.

import { CAPTURE_FN } from "../contract.js";
import { captureIn, type Mode } from "./index.js";

(globalThis as unknown as Record<string, (mode: Mode) => unknown>)[CAPTURE_FN] = (mode) => captureIn(window, mode);
