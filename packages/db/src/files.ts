import type { Queryable } from './client.js';

/**
 * Uploaded files: operator logos and metric workbooks.
 *
 * Only the metadata lives here. The bytes live on disk under a path this row
 * records, and that path is generated rather than derived from anything the
 * uploader supplied — see the storage module in the API.
 */

export type StoredFileKind = 'branding-logo' | 'bank-metric' | 'developer-metric' | 'other';

export interface StoredFile {
  id: string;
  organisationId: string;
  kind: StoredFileKind;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  storagePath: string;
  uploadedBy: string | null;
  createdAt: Date;
}

interface FileRow {
  id: string;
  organisation_id: string;
  kind: StoredFileKind;
  original_filename: string;
  content_type: string;
  byte_size: string;
  sha256: string;
  storage_path: string;
  uploaded_by: string | null;
  created_at: Date;
}

function toFile(row: FileRow): StoredFile {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    kind: row.kind,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    // bigint arrives as a string; sizes here are far inside Number's range.
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    storagePath: row.storage_path,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
  };
}

export interface StoredFileInput {
  organisationId: string;
  kind: StoredFileKind;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  storagePath: string;
  uploadedBy?: string | null | undefined;
}

export async function createStoredFile(db: Queryable, input: StoredFileInput): Promise<StoredFile> {
  const { rows } = await db.query<FileRow>(
    `INSERT INTO stored_file (organisation_id, kind, original_filename, content_type,
                              byte_size, sha256, storage_path, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      input.organisationId,
      input.kind,
      input.originalFilename,
      input.contentType,
      String(input.byteSize),
      input.sha256,
      input.storagePath,
      input.uploadedBy ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('Insert returned no row.');
  return toFile(row);
}

export async function getStoredFile(db: Queryable, id: string): Promise<StoredFile | null> {
  const { rows } = await db.query<FileRow>('SELECT * FROM stored_file WHERE id = $1', [id]);
  return rows[0] ? toFile(rows[0]) : null;
}

export async function deleteStoredFile(db: Queryable, id: string): Promise<StoredFile | null> {
  const { rows } = await db.query<FileRow>('DELETE FROM stored_file WHERE id = $1 RETURNING *', [id]);
  return rows[0] ? toFile(rows[0]) : null;
}

export async function setOperatorLogo(
  db: Queryable,
  bankOperatorId: string,
  fileId: string | null,
): Promise<string | null> {
  // Returns the file that was there before, so the caller can remove its bytes
  // rather than leaving them behind on disk.
  const { rows } = await db.query<{ previous: string | null }>(
    `UPDATE bank_operator SET branding_logo_file_id = $2
      WHERE id = $1
      RETURNING (SELECT branding_logo_file_id FROM bank_operator WHERE id = $1) AS previous`,
    [bankOperatorId, fileId],
  );
  return rows[0]?.previous ?? null;
}

// ---------------------------------------------------------------------------
// Metric imports
// ---------------------------------------------------------------------------

export interface MetricImport {
  id: string;
  organisationId: string;
  kind: 'bank' | 'developer';
  status: 'draft' | 'confirmed' | 'discarded';
  siteId: string | null;
  developerId: string | null;
  fileId: string | null;
  metricVersion: string;
  originalFilename: string | null;
  byteSize: number | null;
  createdAt: Date;
}

interface ImportRow {
  id: string;
  organisation_id: string;
  kind: 'bank' | 'developer';
  status: 'draft' | 'confirmed' | 'discarded';
  site_id: string | null;
  developer_id: string | null;
  file_id: string | null;
  metric_version: string;
  original_filename: string | null;
  byte_size: string | null;
  created_at: Date;
}

function toImport(row: ImportRow): MetricImport {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    kind: row.kind,
    status: row.status,
    siteId: row.site_id,
    developerId: row.developer_id,
    fileId: row.file_id,
    metricVersion: row.metric_version,
    originalFilename: row.original_filename,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    createdAt: row.created_at,
  };
}

export async function createMetricImport(
  db: Queryable,
  input: {
    organisationId: string;
    kind: 'bank' | 'developer';
    siteId?: string | null;
    developerId?: string | null;
    fileId: string;
    metricVersion: string;
    importedBy?: string | null;
  },
): Promise<MetricImport> {
  const { rows } = await db.query<ImportRow>(
    `INSERT INTO metric_import (organisation_id, kind, site_id, developer_id, file_id,
                                metric_version, imported_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *, NULL::text AS original_filename, NULL::bigint AS byte_size`,
    [
      input.organisationId,
      input.kind,
      input.siteId ?? null,
      input.developerId ?? null,
      input.fileId,
      input.metricVersion,
      input.importedBy ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('Insert returned no row.');
  return toImport(row);
}

export async function listDeveloperMetricImports(
  db: Queryable,
  developerId: string,
): Promise<MetricImport[]> {
  const { rows } = await db.query<ImportRow>(
    `SELECT i.*, f.original_filename, f.byte_size
       FROM metric_import i
       LEFT JOIN stored_file f ON f.id = i.file_id
      WHERE i.kind = 'developer' AND i.developer_id = $1
      ORDER BY i.created_at DESC`,
    [developerId],
  );
  return rows.map(toImport);
}

/** The workbook an allocation for this developer should be written into. */
export async function latestDeveloperMetricImport(
  db: Queryable,
  developerId: string,
): Promise<MetricImport | null> {
  const imports = await listDeveloperMetricImports(db, developerId);
  return imports.find((entry) => entry.status !== 'discarded' && entry.fileId !== null) ?? null;
}

export async function getMetricImport(db: Queryable, id: string): Promise<MetricImport | null> {
  const { rows } = await db.query<ImportRow>(
    `SELECT i.*, f.original_filename, f.byte_size
       FROM metric_import i
       LEFT JOIN stored_file f ON f.id = i.file_id
      WHERE i.id = $1`,
    [id],
  );
  return rows[0] ? toImport(rows[0]) : null;
}

export async function discardMetricImport(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query(`UPDATE metric_import SET status = 'discarded' WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
