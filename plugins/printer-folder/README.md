# @bax-print/printer-folder

A generic file-drop PrinterDriver/1 plugin (spec 033a). It hands finished output to any device or
front-end that watches a folder. It speaks no device protocol and names no vendor or model.

## What it does

- Writes each finished document into `outputDir` as `<jobId>.pdf` or `<jobId>.tiff`.
- When `writeTicket` is on, it also writes `<jobId>.bps-ticket.json`. The ticket is written first,
  so it is already there when a watcher reacts to the output file.
- Every write is atomic. The bytes go to `<name>.part` in the same folder, are fsynced, and then are
  renamed into place. Watchers should ignore `*.part` files.
- It never overwrites an existing file and never writes outside `outputDir`.
- A job is `queued` while its output file is still in the folder. It is `done` once something
  removes or moves the file. Cancelling a queued job removes the output and its ticket. A job that
  is already `done` is left alone, ticket included.

Whatever consumes the folder (a device, a RIP front-end, a script) is outside BPS. BPS does not
start it, configure it, or know what it does with the files. `done` only means "the file has left
the folder". It does not mean "printed".

## Configuration

| Setting           | Type                  | Default           | Rule                                       |
| ----------------- | --------------------- | ----------------- | ------------------------------------------ |
| `outputDir`       | string                | (required)        | Absolute path; must exist and be writable. |
| `acceptedFormats` | `("pdf" \| "tiff")[]` | `["pdf", "tiff"]` | Non-empty.                                 |
| `writeTicket`     | boolean               | `true`            |                                            |
| `deviceName`      | string                | `"Folder output"` | Free text shown by `describe`; 1-128 chars. |

Invalid settings fail with `CONFIG_INVALID`. The message lists every problem at once.

## Ticket JSON (`<jobId>.bps-ticket.json`, version 1)

```json
{
  "bpsTicket": 1,
  "jobId": "job-1",
  "file": "job-1.pdf",
  "format": "pdf",
  "copies": 2,
  "media": { "name": "Satin 200", "widthMm": 210, "heightMm": 297 },
  "createdAt": "2026-11-05T12:00:00.000Z"
}
```

| Field             | Meaning                                                    |
| ----------------- | ---------------------------------------------------------- |
| `bpsTicket`       | Layout version of this ticket; currently `1`.              |
| `jobId`           | The BPS job id; also the output file's base name.          |
| `file`            | Output file name, relative to the folder.                  |
| `format`          | `"pdf"` or `"tiff"`.                                       |
| `copies`          | Requested copies (positive integer, default 1).            |
| `media.name`      | Media name as given by BPS, or `null`.                     |
| `media.widthMm`   | Media width in millimetres, or `null`.                     |
| `media.heightMm`  | Media height in millimetres, or `null`.                    |
| `createdAt`       | ISO 8601 UTC time the ticket was written.                  |

The ticket is advisory. The consumer decides whether to honor it.

## Job ids

A job id is 1-128 characters of letters, digits, `.`, `_` and `-`. It starts with a letter or
digit, does not end with `.`, and does not contain `..`. Any other id is rejected with
`INVALID_JOB_ID`.

## Error codes

| Code                  | When                                                   |
| --------------------- | ------------------------------------------------------ |
| `CONFIG_INVALID`      | Settings failed validation.                            |
| `NOT_CONFIGURED`      | A call arrived before a valid configuration.           |
| `INVALID_JOB_ID`      | The job id is unsafe as a file name.                   |
| `INVALID_SUBMISSION`  | Bad copies, media fields, or empty data.               |
| `FORMAT_NOT_ACCEPTED` | The format is not in `acceptedFormats`.                |
| `OUTPUT_EXISTS`       | The output or ticket file already exists.              |
| `UNKNOWN_JOB`         | Status or cancel for a job this process did not write. |
| `WRITE_FAILED`        | The file system refused a write, rename or remove.     |

## PrinterDriver/1 surface

- `discover` reports one device, `folder-output`, once the plugin is configured.
- Capabilities are minimal: `input: "document"`, with no colorants, bit depths, resolutions or media
  handling, plus `documentFormats`.
- `getStatus` reports `offline` when the plugin is unconfigured or the folder is unusable. Otherwise
  it reports `idle`, with a count of files still waiting.
- `listMedia` returns an empty list, and `accounting` returns no records. `listModes` (1.1) is not
  implemented.
- Raster band submissions (`submit`, `band/data`, `complete`) are declined. This driver takes
  finished documents through `submitDocument`, `getJobStatus` and `cancelJob` on the driver class.
