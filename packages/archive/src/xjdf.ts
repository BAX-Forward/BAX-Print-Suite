import type { Job } from '@bax-print/core';

/**
 * Minimal XJDF 2.0 product ticket export (CIP4 XJDF: product intent plus an audit entry).
 * Values that have no direct XJDF attribute in our model are carried as `GeneralID` pairs.
 */

export const XJDF_NAMESPACE = 'http://www.CIP4.org/JDFSchema_2_0';
export const XJDF_VERSION = '2.0';
const ID_PREFIX = 'bps.';
const PT_PER_MM = 72 / 25.4;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function attrs(values: Readonly<Record<string, string | number | undefined>>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join('');
}

function points(mm: number): string {
  return String(Math.round(mm * PT_PER_MM * 1000) / 1000);
}

export interface XjdfExportOptions {
  readonly at: Date;
  readonly agentName?: string;
}

/** Serializes the job ticket as an XJDF 2.0 product description. Sizes are converted to points. */
export function exportTicketXjdf(job: Job, options: XjdfExportOptions): string {
  const { intent } = job.ticket;
  const ids: [string, string | undefined][] = [
    ['jobName', job.name],
    ['customerRef', job.customerRef],
    ['reprintOf', job.reprintOf],
    ['deviceId', job.deviceId],
    ['mediumId', job.mediumId],
    ['colorSetupRevisionId', job.colorSetupRevisionId],
    ['mediaIntent', intent.mediaIntent],
    ['colorIntent', intent.colorIntent],
    ...job.tags.map((tag): [string, string] => ['tag', tag]),
  ];

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<XJDF${attrs({ xmlns: XJDF_NAMESPACE, JobID: job.id, Types: 'Product', Version: XJDF_VERSION })}>`,
    ...ids
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([usage, value]) => `  <GeneralID${attrs({ IDUsage: `${ID_PREFIX}${usage}`, IDValue: value })}/>`),
    '  <AuditPool>',
    '    <AuditCreated>',
    `      <Header${attrs({ AgentName: options.agentName ?? 'bax-print-suite', Time: options.at.toISOString() })}/>`,
    '    </AuditCreated>',
    '  </AuditPool>',
    '  <ProductList>',
    `    <Product${attrs({ Amount: intent.quantity })}>`,
  ];
  if (intent.finishedSize) {
    const { widthMm, heightMm } = intent.finishedSize;
    lines.push(
      '      <Intent Name="LayoutIntent">',
      `        <LayoutIntent${attrs({ FinishedDimensions: `${points(widthMm)} ${points(heightMm)} 0` })}/>`,
      '      </Intent>',
    );
  }
  lines.push('    </Product>', '  </ProductList>', '</XJDF>', '');
  return lines.join('\n');
}
