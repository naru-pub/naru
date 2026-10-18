// @naru-pub/dev: a local Naru for one site (README.md).
import type * as Api from "./api";
import { start } from "./naru";
import { packagedResources } from "./packaged";

export const startNaru: typeof Api.startNaru = (options) =>
  start(options, packagedResources());
