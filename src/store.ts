export const KINDS = ["memory", "worklog"] as const;
export type Kind = (typeof KINDS)[number];

export interface Entry {
  id: number;
  kind: Kind;
  title: string;
  content: string;
  project: string | null;
  tags: string[];
  device: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewEntry {
  kind: Kind;
  title: string;
  content: string;
  project?: string | undefined;
  tags?: string[] | undefined;
  device?: string | undefined;
}

export interface EntryPatch {
  kind?: Kind | undefined;
  title?: string | undefined;
  content?: string | undefined;
  project?: string | null | undefined;
  tags?: string[] | undefined;
}

export interface SearchParams {
  query?: string | undefined;
  kind?: Kind | undefined;
  project?: string | undefined;
  tag?: string | undefined;
  since?: string | undefined;
  limit: number;
  offset: number;
}

export type SearchResult = Omit<Entry, "content"> & { preview: string };

type EntryRow = Omit<Entry, "tags"> & { tags: string };

const PREVIEW_CHARS = 300;
const COLUMNS =
  "e.id, e.kind, e.title, e.content, e.project, e.tags, e.device, e.created_at, e.updated_at";

function toEntry(row: EntryRow): Entry {
  return { ...row, tags: JSON.parse(row.tags) as string[] };
}

/** The trigram index can only match terms of at least 3 characters. */
function isIndexable(term: string): boolean {
  return [...term].length >= 3;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function createEntry(
  db: D1Database,
  entry: NewEntry,
): Promise<Entry> {
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `INSERT INTO entries (kind, title, content, project, tags, device, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      entry.kind,
      entry.title,
      entry.content,
      entry.project ?? null,
      JSON.stringify(entry.tags ?? []),
      entry.device ?? null,
      now,
      now,
    )
    .first<EntryRow>();
  return toEntry(row!);
}

export async function getEntry(
  db: D1Database,
  id: number,
): Promise<Entry | null> {
  const row = await db
    .prepare("SELECT * FROM entries WHERE id = ?")
    .bind(id)
    .first<EntryRow>();
  return row && toEntry(row);
}

export async function updateEntry(
  db: D1Database,
  id: number,
  patch: EntryPatch,
): Promise<Entry | null> {
  const sets: string[] = [];
  const values: (string | null)[] = [];
  const set = (column: string, value: string | null) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.kind !== undefined) set("kind", patch.kind);
  if (patch.title !== undefined) set("title", patch.title);
  if (patch.content !== undefined) set("content", patch.content);
  if (patch.project !== undefined) set("project", patch.project);
  if (patch.tags !== undefined) set("tags", JSON.stringify(patch.tags));
  set("updated_at", new Date().toISOString());

  const row = await db
    .prepare(`UPDATE entries SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
    .bind(...values, id)
    .first<EntryRow>();
  return row && toEntry(row);
}

export async function deleteEntry(
  db: D1Database,
  id: number,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM entries WHERE id = ?")
    .bind(id)
    .run();
  return result.meta.changes > 0;
}

/**
 * All query terms must match. Terms of 3+ characters use the FTS index and rank
 * by relevance; shorter ones (common in Korean, e.g. "작업") fall back to LIKE.
 * Without any indexable term, results are ordered by most recently updated.
 */
export async function searchEntries(
  db: D1Database,
  params: SearchParams,
): Promise<SearchResult[]> {
  const terms = params.query?.split(/\s+/).filter(Boolean) ?? [];
  const ftsTerms = terms.filter(isIndexable);
  const likeTerms = terms.filter((term) => !isIndexable(term));

  const where: string[] = [];
  const whereValues: (string | number)[] = [];
  const filter = (clause: string, ...values: (string | number)[]) => {
    where.push(clause);
    whereValues.push(...values);
  };

  if (ftsTerms.length > 0) {
    const match = ftsTerms
      .map((term) => `"${term.replace(/"/g, '""')}"`)
      .join(" AND ");
    filter("entries_fts MATCH ?", match);
  }
  for (const term of likeTerms) {
    const pattern = `%${escapeLike(term)}%`;
    filter(
      `(e.title LIKE ? ESCAPE '\\' OR e.content LIKE ? ESCAPE '\\' OR e.tags LIKE ? ESCAPE '\\')`,
      pattern,
      pattern,
      pattern,
    );
  }
  if (params.kind) filter("e.kind = ?", params.kind);
  if (params.project) filter("e.project = ?", params.project);
  if (params.tag) {
    filter(
      "EXISTS (SELECT 1 FROM json_each(e.tags) WHERE json_each.value = ?)",
      params.tag,
    );
  }
  if (params.since) filter("e.updated_at >= ?", params.since);

  const useFts = ftsTerms.length > 0;
  const sql = `
    SELECT ${COLUMNS}${useFts ? ", snippet(entries_fts, 1, '', '', '…', 48) AS snippet" : ""}
    FROM ${useFts ? "entries_fts JOIN entries e ON e.id = entries_fts.rowid" : "entries e"}
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${useFts ? "bm25(entries_fts), " : ""}e.updated_at DESC, e.id DESC
    LIMIT ? OFFSET ?`;

  const { results } = await db
    .prepare(sql)
    .bind(...whereValues, params.limit, params.offset)
    .all<EntryRow & { snippet?: string }>();

  return results.map(({ snippet, ...row }) => {
    const { content, ...rest } = toEntry(row);
    const preview =
      snippet ??
      (content.length > PREVIEW_CHARS
        ? `${content.slice(0, PREVIEW_CHARS)}…`
        : content);
    return { ...rest, preview };
  });
}
