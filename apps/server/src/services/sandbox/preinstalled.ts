/**
 * Pip packages baked into `Dockerfile.sandbox`. Keep this list identical to the
 * image's `pip install --no-cache-dir` block (lowercase, pip-normalized names).
 * The sibling test parses the Dockerfile so the two cannot drift.
 */
export const SANDBOX_PREINSTALLED_PIP_PACKAGES = [
  'beautifulsoup4',
  'chardet',
  'lxml',
  'matplotlib',
  'numpy',
  'openpyxl',
  'pandas',
  'pdfplumber',
  'pillow',
  'pymupdf',
  'pypdf',
  'python-dateutil',
  'python-docx',
  'python-pptx',
  'pyyaml',
  'reportlab',
  'requests',
  'scipy',
  'tabulate',
  'xlrd',
  'xlsxwriter',
] as const;

export type SandboxPreinstalledPipPackage = (typeof SANDBOX_PREINSTALLED_PIP_PACKAGES)[number];
