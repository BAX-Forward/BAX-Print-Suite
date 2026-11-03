// Plugin process entry point: serves the driver over BPP on stdio. Identity
// comes from the manifest so `initialize` always matches it.

import { readFileSync } from "node:fs";
import { serveCutterDriver } from "@bax-print/plugin-sdk";
import { createSummaS2Driver } from "./driver.js";

const manifest = JSON.parse(readFileSync(new URL("../bps-plugin.json", import.meta.url), "utf8")) as {
  id: string;
  version: string;
  capabilities?: Record<string, unknown>;
};

serveCutterDriver(createSummaS2Driver(), { id: manifest.id, version: manifest.version, capabilities: manifest.capabilities });
