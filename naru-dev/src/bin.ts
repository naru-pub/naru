#!/usr/bin/env node
// The naru-dev command, as the package ships it.
import { main } from "./cli";
import { packagedInfo, packagedResources } from "./packaged";

process.exitCode = await main(
  process.argv.slice(2),
  packagedResources(),
  packagedInfo(),
);
