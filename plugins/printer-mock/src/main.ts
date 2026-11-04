#!/usr/bin/env node
/** Process entry point: serves the mock PrinterDriver/1 over BPP on stdin/stdout. */
import {
  createStderrLogger,
  INTERFACE_VERSIONS,
  PluginServer,
  registerPrinterDriver,
} from '@bax-print/plugin-sdk';
import { MockPrinterDriver } from './driver.js';

const server: PluginServer = new PluginServer({
  plugin: { id: 'org.bax-print.printer.mock', name: 'Mock Printer Driver', version: '0.1.0' },
  offers: [{ interface: 'PrinterDriver', version: INTERFACE_VERSIONS.PrinterDriver }],
  capabilities: { transports: ['file'] },
  log: createStderrLogger('printer-mock'),
  onConfigure: (settings): void => driver.configure(settings),
  // Flush the final response before exiting.
  onExit: (code) => {
    process.stdout.write('', () => process.exit(code));
  },
});
const driver: MockPrinterDriver = new MockPrinterDriver(server);
registerPrinterDriver(server, driver);
