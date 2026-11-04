export * from "./stub.js";
export * from "./cutter.js";
export * from "./cutter-bpp.js";

/**
 * BPP v1 (spec 001). The full module is available as the `bpp` namespace; names that cannot
 * clash with the stub's exports are also re-exported at top level. Generic JSON-RPC and SemVer
 * helpers stay namespaced so they never shadow the stub's equivalents.
 */
export * as bpp from "./bpp/index.js";
export {
  assertPluginManifest,
  BandMethods,
  BPP_PROTOCOL_VERSION,
  BPP_SCHEMAS,
  Connection,
  createStderrLogger,
  ErrorCodes,
  FrameDecoder,
  FramingError,
  INTERFACE_NAMES,
  INTERFACE_VERSIONS,
  LifecycleMethods,
  ManifestError,
  negotiateInterfaces,
  negotiateVersion,
  PLUGIN_MANIFEST_SCHEMA,
  PluginServer,
  PrinterDriverMethods,
  PrinterDriverNotifications,
  readFileBand,
  registerPrinterDriver,
  runPrinterDriverConformance,
  silentLogger,
  validatePluginManifest,
  validateSchema,
  writeFileBand,
} from "./bpp/index.js";
export type {
  AccountingRecord,
  AccountingResult,
  BandDataParams,
  BandHandle,
  BandMessage,
  BandReleaseParams,
  BppPluginInfo,
  CompleteResult,
  DeviceParams,
  DiscoveredPrinter,
  DiscoverResult,
  FileBandHandle,
  InitializeParams,
  InitializeResult,
  InterfaceName,
  InterfaceOffer,
  InterfaceRequirement,
  JsonSchema,
  ListMediaResult,
  MediaInfo,
  PrinterCapabilities,
  PrinterConformanceCheck,
  PrinterConformanceReport,
  PrinterDriverV1,
  PrinterState,
  PrinterStatus,
  PluginServerOptions,
  SchemaError,
  SdkLogger,
  SubmissionParams,
  SubmissionState,
  SubmissionStatusNotification,
  SubmitParams,
  SubmitResult,
} from "./bpp/index.js";
export * from "./inspector.js";
export * from "./inspector-rpc.js";
