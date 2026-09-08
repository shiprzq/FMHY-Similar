/**
 * Storage codec.
 *
 * The dataset is ~20k resources whose category / subcategory / section / page /
 * tag / platform / feature / type strings repeat thousands of times, and whose
 * `fmhyUrl` is fully derivable from `page` + the section anchor. Storing the
 * raw JSON costs ~9.5 MB, which is uncomfortably close to Chrome's default
 * 10 MB `storage.local` quota.
 *
 * This codec:
 *   - interns every repeated string into a shared dictionary
 *   - encodes each resource as a fixed-order array of dictionary indices
 *   - reconstructs `fmhyUrl` from `page` + `section`
 *   - drops empty trailing fields
 *
 * It is lossless for every field the extension uses, and cuts the stored size
 * by roughly 3x. Decoding is a single linear pass — a few tens of ms for the
 * whole database, done once per service-worker lifetime.
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;

  const FORMAT = 'fmhys-packed-1';
  const SITE = 'https://fmhy.net/';

  /** Field order in the packed row. */
  // 0 name(raw) 1 url(raw) 2 page(dict) 3 category(dict) 4 subcategory(dict)
  // 5 section(dict) 6 description(raw) 7 tags(dict[]) 8 platforms(dict[])
  // 9 features(dict[]) 10 type(dict) 11 starred(0|1) 12 mirrors(raw[])
  // 13 idOverride(raw|0)  -- only when the id is not reproducible

  function pack(dataset) {
    const dict = [];
    const dictIndex = new Map();
    const intern = (s) => {
      if (!s) return 0;
      let i = dictIndex.get(s);
      if (i === undefined) {
        dict.push(s);
        i = dict.length; // 1-based; 0 means "empty"
        dictIndex.set(s, i);
      }
      return i;
    };
    const internList = (arr) => (arr && arr.length ? arr.map(intern) : 0);

    const rows = new Array(dataset.resources.length);
    for (let i = 0; i < dataset.resources.length; i++) {
      const r = dataset.resources[i];
      const derivedFmhy = deriveFmhyUrl(r.page, r.section);
      const derivedId = FMHYS.schema.makeId({
        page: r.page, category: r.category, name: r.name, url: r.url
      });

      rows[i] = [
        r.name,
        r.url,
        intern(r.page || ''),
        intern(r.category || ''),
        intern(r.subcategory || ''),
        intern(r.section || ''),
        r.description || 0,
        internList(r.tags),
        internList(r.platforms),
        internList(r.features),
        intern(r.type || ''),
        r.starred ? 1 : 0,
        (r.mirrors && r.mirrors.length) ? r.mirrors : 0,
        // Store the id only when it cannot be recomputed, and the fmhyUrl only
        // when it does not match the derived value.
        r.id === derivedId ? 0 : r.id,
        r.fmhyUrl === derivedFmhy ? 0 : r.fmhyUrl
      ];

      // Trim trailing zeros to save bytes.
      let end = rows[i].length;
      while (end > 2 && rows[i][end - 1] === 0) end--;
      if (end < rows[i].length) rows[i].length = end;
    }

    return {
      format: FORMAT,
      schemaVersion: dataset.schemaVersion,
      version: dataset.version,
      source: dataset.source,
      generatedAt: dataset.generatedAt,
      installedAt: dataset.installedAt || null,
      dict,
      rows
    };
  }

  function deriveFmhyUrl(page, section) {
    const p = page ? String(page).replace(/^\/+/, '') : '';
    const anchor = section ? FMHYS.text.slugify(section) : '';
    return SITE + p + (anchor ? '#' + anchor : '');
  }

  function unpack(packed) {
    if (!packed || packed.format !== FORMAT || !Array.isArray(packed.rows) || !Array.isArray(packed.dict)) {
      return null;
    }
    const d = packed.dict;
    const s = (i) => (i ? (d[i - 1] || '') : '');
    const sl = (v) => (Array.isArray(v) ? v.map(s) : []);

    const resources = new Array(packed.rows.length);
    for (let i = 0; i < packed.rows.length; i++) {
      const row = packed.rows[i];
      const name = row[0];
      const url = row[1];
      const page = s(row[2]);
      const category = s(row[3]);
      const subcategory = s(row[4]);
      const section = s(row[5]);
      const idOverride = row[13] || 0;
      const fmhyOverride = row[14] || 0;

      resources[i] = {
        id: idOverride || FMHYS.schema.makeId({ page, category, name, url }),
        name,
        url,
        fmhyUrl: fmhyOverride || deriveFmhyUrl(page, section),
        category,
        subcategory,
        section,
        page,
        description: row[6] || '',
        tags: sl(row[7]),
        platforms: sl(row[8]),
        features: sl(row[9]),
        type: s(row[10]) || 'site',
        starred: row[11] === 1,
        mirrors: Array.isArray(row[12]) ? row[12] : []
      };
    }

    return {
      schemaVersion: packed.schemaVersion,
      version: packed.version,
      source: packed.source,
      generatedAt: packed.generatedAt,
      installedAt: packed.installedAt || null,
      resources
    };
  }

  /** Split the packed rows into storage-sized chunks. */
  function chunkRows(rows, size) {
    const out = [];
    for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
    return out;
  }

  FMHYS.codec = { FORMAT, pack, unpack, chunkRows, deriveFmhyUrl };
})(typeof globalThis !== 'undefined' ? globalThis : self);
