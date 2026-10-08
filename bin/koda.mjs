#!/usr/bin/env node
// Resolve the runtime and source relative to this installed package, never cwd.
import { register } from "tsx/esm/api";
register();
if (process.argv[2] === "agent") process.argv.splice(2, 1);
await import("../src/cli.ts");
