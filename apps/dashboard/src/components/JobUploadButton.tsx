import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../api/ApiContext';
import { ApiError, errorMessage } from '../api/client';
import { INLINE_ERRORS, queryKeys } from '../api/queries';
import { createUploadClient, jobNameFromFileName, PDF_TYPE, type UploadClient } from '../api/uploadClient';
import { formatBytes } from '../lib/format';
import { jobUploadStrings } from './jobUploadStrings';
import ui from './ui.module.css';

/**
 * Spec 052b: the Upload PDF button on the job list, loaded lazily by JobsUploadPage.tsx and only in
 * builds with BPS_DASHBOARD_JOB_UPLOAD=1. It POSTs the file to /jobs as application/pdf with the
 * file name in x-bps-job-name, reports errors by their `{error: {code}}` code and refreshes the list.
 */

const t = jobUploadStrings;
const ACCEPT = `${PDF_TYPE},.pdf`;
/** `details` key of upload_too_large carrying the server limit (Spec 052a). */
const MAX_BYTES_DETAIL = 'maxBytes';

type Phase = 'reading' | 'uploading';

class FileReadError extends Error {
  constructor() {
    super(t.errors.readFailed);
    this.name = 'FileReadError';
  }
}

/** The file's bytes (FileReader rather than Blob.arrayBuffer, which older engines and jsdom lack). */
export function readFileBytes(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result === null || typeof result === 'string') reject(new FileReadError());
      else resolve(new Uint8Array(result));
    };
    reader.onerror = () => reject(new FileReadError());
    reader.readAsArrayBuffer(file);
  });
}

/** The message shown for a failed upload, chosen by the error code of the response. */
export function uploadErrorMessage(error: unknown): string {
  if (error instanceof FileReadError) return error.message;
  if (!(error instanceof ApiError)) return t.errors.network;
  switch (error.code) {
    case 'upload_too_large': {
      const maxBytes = error.details?.[MAX_BYTES_DETAIL];
      return typeof maxBytes === 'number' ? t.errors.tooLarge(formatBytes(maxBytes)) : t.errors.tooLargeNoLimit;
    }
    case 'upload_media_type_unsupported':
      return t.errors.mediaType;
    case 'upload_not_pdf':
      return t.errors.notPdf;
  }
  // A proxy may answer 413 without the JSON body; 404/405 mean BPS_JOB_INTAKE is off on the server.
  if (error.status === 413) return t.errors.tooLargeNoLimit;
  if (error.status === 404 || error.status === 405) return t.errors.unavailable;
  return errorMessage(error);
}

export function JobUploadButton({ client }: { client?: UploadClient }) {
  const api = useApi();
  const queryClient = useQueryClient();
  // Same origin as the API client (eventsUrl is built on its base URL).
  const uploader = useMemo(() => client ?? createUploadClient({ baseUrl: new URL(api.eventsUrl()).origin }), [api, client]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>('reading');

  const upload = useMutation({
    mutationFn: async (file: File) => {
      setPhase('reading');
      const bytes = await readFileBytes(file);
      setPhase('uploading');
      return uploader.uploadJob(bytes, jobNameFromFileName(file.name));
    },
    meta: INLINE_ERRORS,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.jobLists }),
  });

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Clear the input so choosing the same file again uploads it again.
    event.target.value = '';
    if (file) upload.mutate(file);
  };

  const fileName = upload.variables?.name ?? '';

  return (
    <section aria-label={t.label} className={ui.toolbar}>
      <button type="button" disabled={upload.isPending} onClick={() => inputRef.current?.click()}>
        {t.button}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        aria-label={t.fileLabel}
        className="visually-hidden"
        tabIndex={-1}
        disabled={upload.isPending}
        onChange={onFile}
      />
      <span role="status">
        {upload.isPending && (
          <>
            <progress aria-label={t.progress} /> {phase === 'reading' ? t.reading(fileName) : t.uploading(fileName)}
          </>
        )}
        {upload.isSuccess && t.done(upload.data.name)}
      </span>
      {upload.isError && (
        <p role="alert" className={ui.error}>
          {uploadErrorMessage(upload.error)}
        </p>
      )}
    </section>
  );
}

export default JobUploadButton;
