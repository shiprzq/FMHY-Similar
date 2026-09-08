/**
 * Settings page controller.
 *
 * All DOM writes use textContent / element construction. No innerHTML.
 */
(function () {
  'use strict';
  const FMHYS = globalThis.FMHYS;
  const B = FMHYS.browser;

  const $ = (id) => document.getElementById(id);

  let settings = null;
  let dbMeta = null;
  let updating = false;

  async function send(type, payload) {
    try {
      const res = await B.runtime.sendMessage(Object.assign({ type }, payload || {}));
      return res || { ok: false, error: 'no-response' };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  // ------------------------------------------------------------------- toast

  let toastTimer = 0;
  function toast(message, kind) {
    const t = $('toast');
    t.textContent = message;
    t.dataset.kind = kind || '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }

  function notice(message, kind) {
    const n = $('db-notice');
    if (!message) { n.hidden = true; return; }
    n.textContent = message;
    n.dataset.kind = kind || '';
    n.hidden = false;
  }

  // ------------------------------------------------------------------ theme

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.dataset.theme = theme;
    } else {
      delete document.documentElement.dataset.theme;
    }
  }

  // --------------------------------------------------------------- settings

  function fillSettings(s) {
    settings = s;
    $('s-enabled').checked = s.enabled;
    $('s-indicators').checked = s.showIndicators;
    $('s-favbuttons').checked = s.showFavoriteButtons;
    $('s-dblclick').checked = s.dblClickFindSimilar;
    $('s-simbtn').value = s.showSimilarButton;
    $('s-max').value = 5;
    $('s-minscore').value = String(s.minSimilarity);
    $('s-minscore-val').textContent = String(s.minSimilarity);
    $('s-anim').checked = s.animations;
    $('s-density').value = s.compactUi;
    $('s-autoupdate').checked = s.autoUpdateDatabase;
    $('s-recent').checked = s.trackRecentlyViewed;
    const radio = document.querySelector(`input[name="theme"][value="${s.theme}"]`);
    if (radio) radio.checked = true;
    applyTheme(s.theme);
  }

  async function patch(p) {
    const res = await send('settings:set', { patch: p });
    if (res.ok) {
      fillSettings(res.settings);
      toast('Saved', 'ok');
    } else {
      toast('Could not save: ' + (res.error || 'unknown error'), 'err');
    }
  }

  function wireSettings() {
    const bind = (id, key) => {
      $(id).addEventListener('change', () => patch({ [key]: $(id).checked }));
    };
    bind('s-enabled', 'enabled');
    bind('s-indicators', 'showIndicators');
    bind('s-favbuttons', 'showFavoriteButtons');
    bind('s-dblclick', 'dblClickFindSimilar');
    bind('s-anim', 'animations');
    bind('s-autoupdate', 'autoUpdateDatabase');
    bind('s-recent', 'trackRecentlyViewed');

    $('s-simbtn').addEventListener('change', () => patch({ showSimilarButton: $('s-simbtn').value }));
    $('s-density').addEventListener('change', () => patch({ compactUi: $('s-density').value }));

    $('s-minscore').addEventListener('input', () => {
      $('s-minscore-val').textContent = $('s-minscore').value;
    });
    $('s-minscore').addEventListener('change', () => {
      patch({ minSimilarity: Number($('s-minscore').value) });
    });

    for (const r of document.querySelectorAll('input[name="theme"]')) {
      r.addEventListener('change', () => {
        if (r.checked) { applyTheme(r.value); patch({ theme: r.value }); }
      });
    }

    $('btn-reset-settings').addEventListener('click', async () => {
      if (!confirm('Reset every setting to its default? Your favorites and database are not affected.')) return;
      const res = await send('settings:reset');
      if (res.ok) { fillSettings(res.settings); toast('Settings reset', 'ok'); }
    });

    $('btn-clear-recent').addEventListener('click', async () => {
      await send('recent:clear');
      toast('Recently viewed cleared', 'ok');
    });
  }

  // --------------------------------------------------------------- database

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function fillDb(meta) {
    dbMeta = meta;
    if (!meta || !meta.count) {
      $('db-version').textContent = '—';
      $('db-updated').textContent = '—';
      $('db-count').textContent = '0';
      $('db-source').textContent = '—';
      $('db-schema').textContent = '—';
      notice(meta && meta.error
        ? 'Database error: ' + meta.error
        : 'No resource database is installed. Press “Update database” to build one from the FMHY wiki.',
        'err');
      return;
    }
    $('db-version').textContent = meta.version || '—';
    $('db-updated').textContent = fmtDate(meta.installedAt || meta.generatedAt);
    $('db-count').textContent = Number(meta.count).toLocaleString();
    $('db-source').textContent = meta.source || '—';
    $('db-source').title = meta.source || '';
    $('db-schema').textContent = 'v' + (meta.schemaVersion || '?');
    notice('', '');
  }

  function setProgress(pct, text) {
    const p = $('db-progress');
    p.hidden = false;
    $('db-bar').style.width = Math.max(0, Math.min(100, pct)) + '%';
    $('db-progress-text').textContent = text;
  }

  function hideProgress() {
    $('db-progress').hidden = true;
    $('db-bar').style.width = '0%';
  }

  async function doUpdate() {
    if (updating) return;
    updating = true;
    const btn = $('btn-update');
    btn.disabled = true;
    $('btn-reset').disabled = true;
    notice('', '');

    const mode = $('s-mode').value;
    const total = mode === 'single' ? 1 : 24;

    // The worker does the work; we animate an indicative progress bar because
    // MV3 messaging is request/response and cannot stream progress back.
    let step = 0;
    setProgress(4, mode === 'single' ? 'Downloading single-page.md…' : 'Downloading wiki pages…');
    const ticker = setInterval(() => {
      step = Math.min(step + 1, total - 1);
      setProgress(6 + (step / total) * 78, `Downloading and parsing… (${step}/${total})`);
    }, mode === 'single' ? 900 : 420);

    const res = await send('db:update', { mode });
    clearInterval(ticker);

    if (res.ok && res.result && res.result.ok) {
      setProgress(100, 'Done');
      const r = res.result;
      const s = r.stats || {};
      fillDb(res.meta);
      notice(
        `Installed ${Number(r.count).toLocaleString()} resources (v${r.version}). ` +
        `Parsed ${s.received || 0}, dropped ${s.rejected || 0} malformed, merged ${s.deduped || 0} duplicates.`,
        'ok'
      );
      toast('Database updated', 'ok');
    } else {
      hideProgress();
      const r = (res && res.result) || {};
      const msg = r.error || res.error || 'Unknown error.';
      notice(
        `Update failed during “${r.phase || 'request'}”: ${msg} ` +
        `Your existing database was left untouched.`,
        'err'
      );
      toast('Update failed', 'err');
    }

    setTimeout(hideProgress, 1400);
    btn.disabled = false;
    $('btn-reset').disabled = false;
    updating = false;
    await loadLog();
  }

  async function doReset() {
    if (!confirm('Reset the resource database back to the version bundled with the extension? Your favorites are kept.')) return;
    const res = await send('db:reset');
    if (res.ok) { fillDb(res.meta); toast('Database reset', 'ok'); }
    else toast('Reset failed', 'err');
    await loadLog();
  }

  function doImport() {
    $('file-import').click();
  }

  async function handleImportFile(file) {
    if (!file) return;
    if (file.size > 64 * 1024 * 1024) { toast('File is too large (max 64 MB)', 'err'); return; }
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (e) {
      notice('That file is not valid JSON: ' + String(e.message || e), 'err');
      toast('Import failed', 'err');
      return;
    }
    const res = await send('db:import', { dataset: parsed });
    if (res.ok && res.result && res.result.ok) {
      fillDb(res.meta);
      const s = res.result.stats || {};
      notice(
        `Imported ${Number(res.result.count).toLocaleString()} resources. ` +
        `Dropped ${s.rejected || 0} malformed, merged ${s.deduped || 0} duplicates.`,
        'ok'
      );
      toast('Database imported', 'ok');
    } else {
      const r = (res && res.result) || {};
      notice('Import rejected: ' + (r.error || res.error || 'unknown error') +
        ' Your existing database was kept.', 'err');
      toast('Import rejected', 'err');
    }
    await loadLog();
  }

  async function doExport() {
    const res = await send('db:search', { query: '', limit: 1 }); // warms the worker
    const metaRes = await send('db:meta');
    if (!metaRes.ok || !metaRes.meta.count) { toast('Nothing to export', 'err'); return; }

    // Pull the dataset out of storage directly — it is the user's own data.
    const dataset = await FMHYS.storage.loadDatabase(false);
    if (!dataset) { toast('Could not read the database', 'err'); return; }

    const payload = {
      meta: {
        version: dataset.version,
        source: dataset.source,
        generatedAt: dataset.generatedAt,
        schemaVersion: dataset.schemaVersion
      },
      resources: dataset.resources
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fmhy-similar-db-${dataset.version}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Exported', 'ok');
  }

  async function loadLog() {
    const res = await send('db:log');
    const ul = $('db-log');
    ul.textContent = '';
    const log = (res.ok && res.log) || [];
    if (log.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No activity yet.';
      ul.appendChild(li);
      return;
    }
    for (const e of log) {
      const li = document.createElement('li');
      const when = document.createElement('span');
      when.className = 'when';
      const d = new Date(e.at);
      when.textContent = isNaN(d) ? '—' : d.toLocaleString(undefined,
        { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      li.appendChild(when);

      const what = document.createElement('span');
      what.className = 'what';
      const badge = document.createElement('span');
      badge.className = e.ok ? 'ok' : 'bad';
      badge.textContent = e.ok ? 'OK' : 'FAIL';
      what.appendChild(badge);
      what.appendChild(document.createTextNode(' '));
      what.appendChild(document.createTextNode(
        e.ok
          ? `${e.phase === 'reset' ? 'Reset' : 'Update'} — ${Number(e.count || 0).toLocaleString()} resources`
          : `${e.phase || 'error'} — ${e.error || 'unknown'}`
      ));
      li.appendChild(what);
      ul.appendChild(li);
    }
  }

  function wireDatabase() {
    $('btn-update').addEventListener('click', doUpdate);
    $('btn-reset').addEventListener('click', doReset);
    $('btn-import').addEventListener('click', doImport);
    $('btn-export').addEventListener('click', doExport);
    $('file-import').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      handleImportFile(f);
    });
  }

  // ------------------------------------------------------------------- init

  async function init() {
    const m = B.runtime.getManifest();
    $('ext-version').textContent = 'v' + (m.version || '0.0.0');

    const s = await send('settings:get');
    fillSettings((s.ok && s.settings) || FMHYS.storage.DEFAULT_SETTINGS);

    const meta = await send('db:meta');
    fillDb(meta.ok ? meta.meta : null);

    wireSettings();
    wireDatabase();
    await loadLog();
  }

  init().catch((e) => toast('Failed to load settings: ' + String(e && e.message || e), 'err'));
})();
