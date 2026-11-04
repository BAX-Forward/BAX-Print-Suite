import type { SdkRenderingIntent } from './common.js';

/** PrinterDriver/1.1 adds the optional `listModes`. Minor version: older drivers stay compatible. */
export const PRINTER_DRIVER_INTERFACE = 'PrinterDriver';
export const PRINTER_DRIVER_MEDIA_VERSION = '1.1';

export interface DeviceMediumReport {
  /** Stable key of the medium within the device's capability profile. */
  mediumKey: string;
  name: string;
  kind?: string;
  widthsMm?: number[];
  thicknessUm?: number;
  form?: 'roll' | 'sheet';
  sides?: 1 | 2;
}

export interface DeviceColorDefaults {
  renderingIntent?: SdkRenderingIntent;
  tacLimitPercent?: number;
  channelLimitsPercent?: Record<string, number>;
}

export interface OutputModeReport {
  /** Stable across calls and driver restarts. */
  modeKey: string;
  name: string;
  resolutionDpi: { x: number; y: number };
  passes: number;
  /** Colorant ids in plane order, e.g. `["cyan","magenta","yellow","black"]`. */
  inkSet: string[];
  direction: 'unidirectional' | 'bidirectional';
  /** Opaque driver parameters; the host stores them and passes them back unchanged. */
  params?: Record<string, unknown>;
  colorDefaults?: DeviceColorDefaults;
}

/** The media-related subset of PrinterDriver/1.1 that the media library consumes. */
export interface PrinterDriverMediaApi {
  listMedia(): Promise<DeviceMediumReport[]>;
  /** Optional (1.1). `mediumHint` is a `mediumKey` from `listMedia()`. */
  listModes?(mediumHint?: string): Promise<OutputModeReport[]>;
}
