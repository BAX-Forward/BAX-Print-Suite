#!/usr/bin/env node
/** Process entry point: serves the folder-output PrinterDriver/1 over BPP on stdin/stdout. */
import {
  createStderrLogger,
  INTERFACE_VERSIONS,
  PluginServer,
  registerPrinterDriver,
} from '@bax-print/plugin-sdk';
import { FolderPrinterDriver } from './driver.js';

const server: PluginServer = new PluginServer({
  plugin: { id: 'org.bax-print.printer.folder', name: 'Folder Output Driver', version: '0.1.0' },
  offers: [{ interface: 'PrinterDriver', version: INTERFACE_VERSIONS.PrinterDriver }],
  capabilities: { transports: ['file'] },
  log: createStderrLogger('printer-folder'),
  onConfigure: (settings): void => driver.configure(settings),
  // Flush the final response before exiting.
  onExit: (code) => {
    process.stdout.write('', () => process.exit(code));
  },
});
const driver: FolderPrinterDriver = new FolderPrinterDriver(server);
registerPrinterDriver(server, driver);
