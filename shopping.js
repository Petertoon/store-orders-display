// Shopping lists for Mama's To-Do screens: up to 5 pages the family names themselves (Groceries, Walmart,
// Clothing…). Each page is a checklist: add items as you think of them, tick them off in the store,
// then clear the ticked ones. Every open screen and phone in the house updates live.

const MAX_PAGES = 5, MAX_ITEMS = 300;

module.exports = function setupShopping(app, { pool, wrap, fail, text, requireLogin, notify }) {
  const L = [requireLogin];
  const todoOnly = (req) => { if (req.account.screen !== 'todo') fail(400, "Shopping lists are for Mama's To-Do screens"); };
  const changed = (req) => notify(req.household_id, { type: 'shopping' });
  const pageOf = async (req, id) => {
    const r = await pool.query('SELECT * FROM shop_pages WHERE id=$1 AND household_id=$2', [Number(id), req.household_id]);
    if (!r.rows[0]) fail(404, 'That list page is gone. It may have been deleted on another screen.');
    return r.rows[0];
  };
  const itemOf = async (req, id) => {
    const r = await pool.query(`SELECT i.* FROM shop_items i JOIN shop_pages p ON p.id = i.page_id
      WHERE i.id=$1 AND p.household_id=$2`, [Number(id), req.household_id]);
    if (!r.rows[0]) fail(404, 'That item is gone. It may have been removed on another screen.');
    return r.rows[0];
  };
  const pageName = (v) => text(v, 'Page name', { max: 30 });

  app.get('/api/shopping', ...L, wrap(async (req, res) => {
    todoOnly(req);
    let pages = (await pool.query('SELECT id, name FROM shop_pages WHERE household_id=$1 ORDER BY position, id', [req.household_id])).rows;
    if (!pages.length) { // first time: start with one page (locked, so two screens opening at once make only one)
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(4247, $1)', [req.household_id]);
        await client.query(`INSERT INTO shop_pages (household_id, name, position) SELECT $1, 'Groceries', 1
          WHERE NOT EXISTS (SELECT 1 FROM shop_pages WHERE household_id=$1)`, [req.household_id]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      pages = (await pool.query('SELECT id, name FROM shop_pages WHERE household_id=$1 ORDER BY position, id', [req.household_id])).rows;
    }
    const items = (await pool.query(`SELECT i.id, i.page_id, i.text, i.done, i.member_id FROM shop_items i
      JOIN shop_pages p ON p.id = i.page_id WHERE p.household_id=$1
      ORDER BY i.done, CASE WHEN i.done THEN i.done_at END DESC, i.id`, [req.household_id])).rows;
    res.json({ max_pages: MAX_PAGES, pages: pages.map((p) => ({ ...p, items: items.filter((i) => i.page_id === p.id) })) });
  }));

  app.post('/api/shopping/pages', ...L, wrap(async (req, res) => {
    todoOnly(req);
    const name = pageName(req.body.name);
    const client = await pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(4247, $1)', [req.household_id]);
      const n = (await client.query('SELECT count(*)::int AS n, COALESCE(max(position),0) AS p FROM shop_pages WHERE household_id=$1', [req.household_id])).rows[0];
      if (n.n >= MAX_PAGES) fail(400, `You can have up to ${MAX_PAGES} list pages. Delete one to make room.`);
      id = (await client.query('INSERT INTO shop_pages (household_id, name, position) VALUES ($1,$2,$3) RETURNING id', [req.household_id, name, n.p + 1])).rows[0].id;
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    changed(req); res.json({ id });
  }));

  app.put('/api/shopping/pages/:id', ...L, wrap(async (req, res) => {
    todoOnly(req); const p = await pageOf(req, req.params.id);
    await pool.query('UPDATE shop_pages SET name=$1 WHERE id=$2', [pageName(req.body.name), p.id]);
    changed(req); res.json({ ok: true });
  }));

  app.delete('/api/shopping/pages/:id', ...L, wrap(async (req, res) => {
    todoOnly(req); const p = await pageOf(req, req.params.id);
    await pool.query('DELETE FROM shop_pages WHERE id=$1', [p.id]);
    changed(req); res.json({ ok: true });
  }));

  app.post('/api/shopping/pages/:id/items', ...L, wrap(async (req, res) => {
    todoOnly(req); const p = await pageOf(req, req.params.id);
    const t = text(req.body.text, 'Item', { max: 200 });
    const n = (await pool.query('SELECT count(*)::int AS n FROM shop_items WHERE page_id=$1', [p.id])).rows[0].n;
    if (n >= MAX_ITEMS) fail(400, 'This page is full. Clear the checked items to make room.');
    const id = (await pool.query('INSERT INTO shop_items (page_id, text, member_id) VALUES ($1,$2,$3) RETURNING id',
      [p.id, t, req.member && req.member.id ? req.member.id : null])).rows[0].id;
    changed(req); res.json({ id });
  }));

  app.put('/api/shopping/items/:id', ...L, wrap(async (req, res) => {
    todoOnly(req); const it = await itemOf(req, req.params.id);
    const t = 'text' in req.body ? text(req.body.text, 'Item', { max: 200 }) : it.text;
    const done = 'done' in req.body ? !!req.body.done : it.done;
    await pool.query('UPDATE shop_items SET text=$1, done=$2, done_at=$3 WHERE id=$4',
      [t, done, done ? (it.done ? it.done_at : new Date()) : null, it.id]);
    changed(req); res.json({ ok: true });
  }));

  app.delete('/api/shopping/items/:id', ...L, wrap(async (req, res) => {
    todoOnly(req); const it = await itemOf(req, req.params.id);
    await pool.query('DELETE FROM shop_items WHERE id=$1', [it.id]);
    changed(req); res.json({ ok: true });
  }));

  // "Clear checked items": done shopping on this page.
  app.post('/api/shopping/pages/:id/clear', ...L, wrap(async (req, res) => {
    todoOnly(req); const p = await pageOf(req, req.params.id);
    const r = await pool.query('DELETE FROM shop_items WHERE page_id=$1 AND done', [p.id]);
    changed(req); res.json({ removed: r.rowCount });
  }));
};
