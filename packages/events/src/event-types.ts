/** Event types used on the bus (ARCHITECTURE §5 plus Spec 008). */
export const EventTypes = {
  jobCreated: 'job.created',
  jobStatusChanged: 'job.status.changed',
  stepStarted: 'step.started',
  stepProgress: 'step.progress',
  stepCompleted: 'step.completed',
  stepFailed: 'step.failed',
  deviceStatus: 'device.status',
  deviceAccounting: 'device.accounting',
  operatorAction: 'operator.action',
  historyCorrection: 'history.correction',
  jobArchived: 'job.archived',
  jobRestored: 'job.restored',
  jobTrashed: 'job.trashed',
  jobPurged: 'job.purged',
  jobImported: 'job.imported',
  jobLegalHoldChanged: 'job.legalhold.changed',
  reprintSetupChanged: 'reprint.setup.changed',
  hotFolderFileDetected: 'hotfolder.file.detected',
  hotFolderFileSkipped: 'hotfolder.file.skipped',
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];
