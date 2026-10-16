import { spawnSync } from "node:child_process";
import {
  loadDeploymentConfig,
  resolveDeploymentConfig,
  writeDeploymentConfig,
  readDeploymentApi,
} from "./deployment-config.mjs";

// Explicit remote migration command. Configuration discovery itself is GET-only.
const environment = process.argv[2];
if (environment !== "test")
  throw new Error("Use the release preflight for production migrations");
const config = await resolveDeploymentConfig(
  loadDeploymentConfig(),
  environment,
  {
    read: readDeploymentApi,
  },
);
const path = writeDeploymentConfig(config, environment);
const result = spawnSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "migrations",
    "apply",
    "DB",
    "--env",
    environment,
    "--remote",
    "--config",
    path,
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
