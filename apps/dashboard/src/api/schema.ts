/**
 * Types for the schemas in /openapi.json, in the shape emitted by openapi-typescript.
 *
 * Regenerate after the API changes:
 *   pnpm --filter dashboard gen:api            (from mock/openapi.json)
 *   pnpm --filter dashboard exec openapi-typescript http://127.0.0.1:8080/openapi.json -o src/api/schema.ts
 *
 * Only `components["schemas"]` is consumed (see ./types.ts), so a regenerated file that also
 * contains `paths` and `operations` is a drop-in replacement.
 */

export interface components {
  schemas: {
    Health: {
      /** @enum {string} */
      status: "ok";
      version: string;
    };
    /** @enum {string} */
    JobStatus:
      | "received"
      | "inspecting"
      | "ready"
      | "held"
      | "queued"
      | "processing"
      | "sent_to_device"
      | "printed"
      | "done"
      | "failed"
      | "cancelled";
    /** @enum {string} */
    JobSort: "createdAt" | "-createdAt" | "priority" | "-priority" | "name" | "-name";
    /** @description Rectangle in PDF points (1/72 in) */
    Box: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    Page: {
      /** @description 0-based page index */
      index: number;
      widthPt: number;
      heightPt: number;
      trimBox?: components["schemas"]["Box"] | null;
    };
    JobError: {
      code: string;
      message: string;
      detail?: string | null;
    };
    /** @enum {string} */
    StepStatus: "pending" | "running" | "completed" | "failed" | "cancelled";
    JobStep: {
      id: string;
      /** @description Pipeline stage, e.g. intake, inspect, output */
      stage: string;
      status: components["schemas"]["StepStatus"];
      pluginId?: string | null;
      /** Format: date-time */
      startedAt?: string | null;
      /** Format: date-time */
      finishedAt?: string | null;
      error?: components["schemas"]["JobError"] | null;
      /** @description Stage output, e.g. {deliveredPath, bytes, sha256} for output */
      result?: {
        [key: string]: unknown;
      } | null;
    };
    AuditEntry: {
      id: string;
      /** Format: date-time */
      time: string;
      type: string;
      message: string;
      data?: {
        [key: string]: unknown;
      } | null;
    };
    Job: {
      /** @description ULID */
      id: string;
      name: string;
      sourcePath?: string | null;
      storedPath?: string | null;
      sizeBytes: number;
      sha256: string;
      pageCount: number;
      pages: components["schemas"]["Page"][];
      status: components["schemas"]["JobStatus"];
      priority: number;
      hotFolderId?: string | null;
      ticketId?: string | null;
      deviceId?: string | null;
      steps: components["schemas"]["JobStep"][];
      audit?: components["schemas"]["AuditEntry"][];
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      updatedAt: string;
      error?: components["schemas"]["JobError"] | null;
    };
    JobPage: {
      items: components["schemas"]["Job"][];
      nextCursor: string | null;
    };
    JobPatch: {
      status?: components["schemas"]["JobStatus"];
      priority?: number;
    };
    Transitions: {
      status: components["schemas"]["JobStatus"];
      allowed: components["schemas"]["JobStatus"][];
    };
    PrintRequest: {
      deviceId: string;
    };
    HotFolderSettings: {
      /** @description Folder for processed originals; null means <hotfolder>/_processed */
      moveProcessedTo?: string | null;
      defaultPriority: number;
      filePatterns: string[];
      dedupe: boolean;
      ticketTemplate?: {
        [key: string]: unknown;
      } | null;
      /** @description Routing rule: jobs from this folder target this device */
      defaultDeviceId?: string | null;
    };
    HotFolderSettingsInput: {
      moveProcessedTo?: string | null;
      defaultPriority?: number;
      filePatterns?: string[];
      dedupe?: boolean;
      defaultDeviceId?: string | null;
    };
    HotFolder: {
      id: string;
      name: string;
      path: string;
      enabled: boolean;
      settings: components["schemas"]["HotFolderSettings"];
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      updatedAt: string;
    };
    HotFolderCreate: {
      name?: string;
      path: string;
      enabled?: boolean;
      settings?: components["schemas"]["HotFolderSettingsInput"];
    };
    HotFolderPatch: {
      name?: string;
      enabled?: boolean;
      settings?: components["schemas"]["HotFolderSettingsInput"];
    };
    PluginInterface: {
      interface: string;
      versions: string;
    };
    Plugin: {
      id: string;
      name: string;
      version: string;
      license: string;
      protocol: string;
      provides: components["schemas"]["PluginInterface"][];
      /** @enum {string} */
      trust: "builtin" | "verified" | "third-party";
      /** @enum {string} */
      state: "running" | "stopped" | "error";
      capabilities?: {
        [key: string]: unknown;
      };
      /** @description JSON Schema for device config (manifest configSchema) */
      configSchema?: {
        [key: string]: unknown;
      } | null;
    };
    DeviceStatus: {
      /** @enum {string} */
      state: "ready" | "busy" | "offline" | "unknown";
      reason?: string | null;
      /** Format: date-time */
      checkedAt?: string | null;
    };
    Device: {
      id: string;
      name: string;
      /** @enum {string} */
      kind: "printer" | "cutter";
      pluginId: string;
      config: {
        [key: string]: unknown;
      };
      autoDispatch: boolean;
      maxConcurrency: number;
      status: components["schemas"]["DeviceStatus"];
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      updatedAt: string;
    };
    DeviceCreate: {
      name: string;
      /** @enum {string} */
      kind: "printer";
      pluginId: string;
      config?: {
        [key: string]: unknown;
      };
      autoDispatch?: boolean;
      maxConcurrency?: number;
    };
    DevicePatch: {
      name?: string;
      config?: {
        [key: string]: unknown;
      };
      autoDispatch?: boolean;
      maxConcurrency?: number;
    };
    FieldError: {
      /** @description Dotted path of the offending field, e.g. path or config.targetDir */
      field: string;
      message: string;
    };
    /** @description RFC 9457 problem details */
    Problem: {
      type?: string;
      title: string;
      status: number;
      detail?: string;
      errors?: components["schemas"]["FieldError"][];
    };
    PreviewUnavailable: {
      /** @enum {string} */
      reason: "no-render-engine";
    };
    /** @description CloudEvents 1.0 envelope */
    CloudEvent: {
      /** @enum {string} */
      specversion: "1.0";
      id: string;
      type: string;
      source: string;
      subject?: string;
      /** Format: date-time */
      time: string;
      datacontenttype?: string;
      data: {
        [key: string]: unknown;
      };
    };
    JobCreatedData: {
      jobId: string;
      job?: components["schemas"]["Job"];
    };
    JobStatusChangedData: {
      jobId: string;
      from: components["schemas"]["JobStatus"];
      to: components["schemas"]["JobStatus"];
      job?: components["schemas"]["Job"];
    };
  };
}
