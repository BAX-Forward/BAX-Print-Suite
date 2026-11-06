/**
 * Strings for the opt-in job upload (052b). Kept out of `strings.ts` so the flag-off production
 * build, including its source maps, does not change.
 */
export const jobUploadStrings = {
  label: 'Upload',
  button: 'Upload PDF',
  fileLabel: 'PDF file to upload',
  progress: 'Upload progress',
  reading: (file: string) => `Reading ${file}…`,
  uploading: (file: string) => `Uploading ${file}…`,
  done: (job: string) => `Uploaded ${job}. It is now in the job list.`,
  errors: {
    tooLarge: (limit: string) => `The file is too large. The server accepts PDFs up to ${limit}.`,
    tooLargeNoLimit: 'The file is too large for the server.',
    mediaType: 'The server accepts PDF uploads only (application/pdf).',
    notPdf: 'This file is not a PDF. Choose a PDF file.',
    unavailable: 'Uploads are not enabled on this server.',
    readFailed: 'The file could not be read.',
    network: 'The upload failed. Check the connection and try again.',
  },
};
