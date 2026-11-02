# Security Policy

## Supported versions
BAX Print Suite is pre-alpha. Security fixes go to `main` only until the first stable release.

## Reporting a vulnerability
Report vulnerabilities **privately** through GitHub's [private vulnerability reporting](https://github.com/BAX-Forward/BAX-Print-Suite/security/advisories/new). Don't open a public issue. If you can't use GitHub, email **security@baxforward.com**.

Please include affected components and versions, reproduction steps, and the impact. We aim to acknowledge reports within 3 business days and agree on a disclosure timeline with you (90 days by default).

## Scope notes
Areas of particular interest: the API and its authentication, hot-folder path handling (path traversal, symlinks), parsing of untrusted PDFs and cut files, plugin process isolation, and the plugin manifest and trust model.
