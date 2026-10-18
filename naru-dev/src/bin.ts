#!/usr/bin/env node
// The naru-dev command, as the package ships it.
import { main } from "./cli";
import { packagedInfo, packagedResources } from "./packaged";

// Stopped, nothing of it is left to wait for.
process.exit(
  await main(process.argv.slice(2), packagedResources(), packagedInfo()),
);
