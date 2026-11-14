// The to-do board. Each house sets up its own columns (name, colors, up to 3 card buttons).
// A to-do is a card; opening it shows the to-do ticket, where everything is typed (or spoken) right on the ticket:
// title, notes, checklist steps, who it's for, due date and priority. Every open screen updates live.
// The last column is "done": a to-do that enters it gets its done time; done to-dos hide after 14 days.

const BLUE = '#3b82f6', GREEN = '#22c55e', GRAY = '#94a3b8', RED = '#ef4444';
const DEFAULT_COLUMNS = [
  { name: 'To Do', color: '#2f4fd8', buttons: [['Urgent', RED, 'top'], ['Someday', GRAY, 'bottom']] },
  { name: 'Today', color: '#c9921a', buttons: [['Start', GREEN, 'middle', 'next']] },
  { name: 'Doing', color: '#7a3cc4', buttons: [['Waiting', GRAY, 'bottom'], ['Finished', GREEN, 'middle', 'next']] },
  { name: 'Done', color: '#2e8b3e', buttons: [] },
];
// Papa's Shop job board: its own standard columns.
const SHOP_COLUMNS = [
  { name: 'New', color: '#2f4fd8', buttons: [['Rush', RED, 'top'], ['Need info', GRAY, 'bottom']] },
  { name: 'Scheduled', color: '#2e8b3e', buttons: [['Start', GREEN, 'middle', 'next']] },
  { name: 'In Progress', color: '#c9921a', buttons: [['Waiting on parts', GRAY, 'bottom'], ['Finished', GREEN, 'middle', 'next']] },
  { name: 'Ready for Pickup', color: '#7a3cc4', buttons: [['Called customer', BLUE], ['Picked up', GREEN, 'middle', 'next']] },
  { name: 'Done', color: '#4b5a6a', buttons: [] },
];
const DONE_DAYS = 14;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDate = (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;

module.exports = function setupBoard(app, deps) {
  const { pool, wrap, fail, text, cleanColor, requireLogin } = deps;
  const L = [requireLogin];

  // ---------- live updates: every open board in a house hears about changes ----------
  const listeners = new Map(); // householdId -> Set(res)
  function notify(householdId, payload) {
    const set = listeners.get(householdId);
    if (!set) return;
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const r of set) r.write(data);
  }
  app.get('/api/events', ...L, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('data: {"type":"hello"}\n\n');
    const id = req.household_id;
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); listeners.get(id)?.delete(res); });
  });

  // ---------- helpers ----------
  const cleanButtons = (list) => (Array.isArray(list) ? list : []).slice(0, 3).map((b) => ({
    label: text(b && b.label, 'Button name', { required: false, max: 24 }) || 'Button',
    enabled: !!(b && b.enabled),
    action: b && b.action === 'next' ? 'next' : 'mark',
    color: cleanColor(b && b.color, BLUE),
    // Where a card marked with this button sits in its column: top, middle (default) or bottom.
    place: ['top', 'bottom'].includes(b && b.place) ? b.place : 'middle',
  }));

  async function withTx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }

  async function columns(db, hid) {
    const sql = 'SELECT * FROM board_columns WHERE household_id=$1 ORDER BY position, id';
    let r = await db.query(sql, [hid]);
    if (!r.rows.length) {
      // First time: the standard columns (locked so two screens can't both make them). Changeable in Board setup.
      await withTx(async (t) => {
        await t.query('SELECT pg_advisory_xact_lock(4244, $1)', [hid]);
        if ((await t.query(sql, [hid])).rows.length) return;
        const scr = (await t.query('SELECT screen FROM households WHERE id=$1', [hid])).rows[0];
        const defaults = scr && scr.screen === 'shop' ? SHOP_COLUMNS : DEFAULT_COLUMNS;
        for (const [i, c] of defaults.entries()) {
          await t.query('INSERT INTO board_columns (household_id, name, color, position, buttons) VALUES ($1,$2,$3,$4,$5)',
            [hid, c.name, c.color, i + 1, JSON.stringify(c.buttons.map(([label, color, place, action]) =>
              ({ label, enabled: true, action: action || 'mark', color, place: place || 'middle' })))]);
        }
      });
      r = await db.query(sql, [hid]);
    }
    return r.rows;
  }
  const who = (req) => req.member || { id: null, name: 'Someone' };
  const log = (db, todoId, req, action) => db.query(
    'INSERT INTO todo_history (todo_id, member_id, member_name, action) VALUES ($1,$2,$3,$4)', [todoId, who(req).id, who(req).name, action]);
  // Typing is saved as you go; log "edited" once per person per half hour instead of on every save.
  async function logEdit(db, todoId, req, action) {
    const r = await db.query(`SELECT 1 FROM todo_history WHERE todo_id=$1 AND action=$2 AND member_id IS NOT DISTINCT FROM $3
      AND created_at > now() - interval '30 minutes' LIMIT 1`, [todoId, action, who(req).id]);
    if (!r.rows[0]) await log(db, todoId, req, action);
  }

  async function loadTodo(db, id, hid, lock = false) {
    const r = await db.query(`SELECT * FROM todos WHERE id=$1 AND household_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [Number(id) || 0, hid]);
    if (!r.rows[0]) fail(404, 'That to-do was not found (it may have been deleted)');
    const cols = await columns(db, hid);
    const t = r.rows[0];
    let idx = cols.findIndex((c) => c.id === t.column_id);
    if (idx < 0) idx = 0; // its column was removed
    t.column_index = idx;
    return { todo: t, cols };
  }
  async function memberName(db, hid, id) {
    if (!id) return null;
    const m = await db.query('SELECT id, name FROM members WHERE id=$1 AND household_id=$2 AND active', [id, hid]);
    if (!m.rows[0]) fail(404, 'Family member not found');
    return m.rows[0];
  }
  // Puts a to-do in a column (any column; skipping is allowed).
  async function placeIn(db, todo, cols, toIndex, req) {
    const to = cols[toIndex];
    if (!to || toIndex === todo.column_index && todo.column_id === to.id) return false;
    const isDone = toIndex === cols.length - 1;
    await db.query(`UPDATE todos SET column_id=$1, status_label=NULL, column_entered_at=now(), done_at=$2, updated_at=now() WHERE id=$3`,
      [to.id, isDone ? new Date() : null, todo.id]);
    await log(db, todo.id, req, `Moved to ${to.name}` + (cols[todo.column_index] ? ` (from ${cols[todo.column_index].name})` : ''));
    return true;
  }

  // ---------- board ----------
  app.get('/api/board', ...L, wrap(async (req, res) => {
    const cols = await columns(pool, req.household_id);
    const last = cols[cols.length - 1];
    const params = [req.household_id];
    let where = 't.household_id = $1';
    if (req.query.done !== 'all' && last) {
      params.push(last.id);
      where += ` AND NOT (t.column_id = $2 AND t.column_entered_at < now() - interval '${DONE_DAYS} days')`;
    }
    const { rows } = await pool.query(
      `SELECT t.id, t.column_id, t.title, t.notes, t.member_id, t.due_date, t.priority, t.status_label,
              t.job_number, t.customer_name, t.customer_phone, t.job_address,
              t.column_entered_at, t.done_at, t.created_at, t.updated_at,
              (SELECT count(*) FROM todo_steps s WHERE s.todo_id = t.id)::int AS steps,
              (SELECT count(*) FROM todo_steps s WHERE s.todo_id = t.id AND s.done)::int AS steps_done
         FROM todos t WHERE ${where} ORDER BY t.column_entered_at, t.id`, params);
    const ids = new Set(cols.map((c) => c.id));
    const todos = rows.map((t) => (ids.has(t.column_id) ? t : { ...t, column_id: cols[0].id }));
    const members = await pool.query('SELECT id, name, color FROM members WHERE household_id=$1 AND active ORDER BY position, id', [req.household_id]);
    res.json({ columns: cols, todos, members: members.rows, done_days: DONE_DAYS });
  }));

  // ---------- board setup (columns and their buttons) ----------
  app.put('/api/columns/:id', ...L, wrap(async (req, res) => {
    const c = await pool.query('SELECT * FROM board_columns WHERE id=$1 AND household_id=$2', [Number(req.params.id) || 0, req.household_id]);
    if (!c.rows[0]) fail(404, 'Column not found');
    const opt = (k) => (k in req.body ? (/^#[0-9a-fA-F]{6}$/.test(req.body[k] || '') ? req.body[k] : null) : c.rows[0][k]);
    await pool.query('UPDATE board_columns SET name=$1, color=$2, buttons=$3, text_color=$4, bg_color=$5, card_color=$6, card_text_color=$7 WHERE id=$8',
      [text(req.body.name, 'Column name', { max: 40 }), cleanColor(req.body.color, c.rows[0].color),
        JSON.stringify(cleanButtons(req.body.buttons)), opt('text_color'), opt('bg_color'), opt('card_color'), opt('card_text_color'), c.rows[0].id]);
    notify(req.household_id, { type: 'columns' });
    res.json({ ok: true });
  }));
  app.post('/api/columns', ...L, wrap(async (req, res) => {
    const id = await withTx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(4245, $1)', [req.household_id]);
      const cols = await columns(db, req.household_id);
      if (cols.length >= 12) fail(400, '12 columns is the most a board can have');
      // New columns go just before the last (Done) column.
      const order = cols.map((c) => c.id);
      const r = await db.query('INSERT INTO board_columns (household_id, name, color, position, buttons) VALUES ($1,$2,$3,0,$4) RETURNING id',
        [req.household_id, text(req.body.name, 'Column name', { max: 40 }), cleanColor(req.body.color, '#2563c9'), JSON.stringify(cleanButtons(req.body.buttons))]);
      order.splice(Math.max(0, cols.length - 1), 0, r.rows[0].id);
      for (const [i, cid] of order.entries()) await db.query('UPDATE board_columns SET position=$1 WHERE id=$2', [i + 1, cid]);
      return r.rows[0].id;
    });
    notify(req.household_id, { type: 'columns' });
    res.json({ id });
  }));
  // Any column can move left or right, including the last one (whatever column ends up last counts as "done").
  app.post('/api/columns/:id/move', ...L, wrap(async (req, res) => {
    await withTx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(4245, $1)', [req.household_id]);
      const cols = await columns(db, req.household_id);
      const i = cols.findIndex((c) => c.id === Number(req.params.id));
      if (i < 0) fail(404, 'Column not found');
      const j = i + (Number(req.body.direction) < 0 ? -1 : 1);
      if (j < 0 || j >= cols.length) return;
      [cols[i], cols[j]] = [cols[j], cols[i]];
      for (const [k, c] of cols.entries()) await db.query('UPDATE board_columns SET position=$1 WHERE id=$2', [k + 1, c.id]);
    });
    notify(req.household_id, { type: 'columns' });
    res.json({ ok: true });
  }));
  // Removing a column moves its to-dos to the first column that's left.
  app.delete('/api/columns/:id', ...L, wrap(async (req, res) => {
    await withTx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(4245, $1)', [req.household_id]);
      const cols = await columns(db, req.household_id);
      const i = cols.findIndex((c) => c.id === Number(req.params.id));
      if (i < 0) fail(404, 'Column not found');
      if (cols.length <= 2) fail(400, 'A board needs at least two columns');
      const to = cols.find((c, k) => k !== i);
      await db.query('UPDATE todos SET column_id=$1, status_label=NULL, column_entered_at=now(), done_at=NULL WHERE column_id=$2', [to.id, cols[i].id]);
      await db.query('DELETE FROM board_columns WHERE id=$1', [cols[i].id]);
    });
    notify(req.household_id, { type: 'columns' });
    res.json({ ok: true });
  }));

  // ---------- to-dos ----------
  // Fields that can be typed on the ticket. Only the ones sent are changed (the ticket saves as you type).
  async function readFields(db, req, b) {
    const f = {};
    if ('title' in b) f.title = text(b.title, 'Title', { required: false, max: 200 });
    if ('notes' in b) f.notes = text(b.notes, 'Notes', { required: false, max: 10000 });
    if ('member_id' in b) f.member_id = b.member_id ? (await memberName(db, req.household_id, b.member_id)).id : null;
    if ('due_date' in b) {
      if (b.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.due_date)) fail(400, 'Due date is not valid');
      f.due_date = b.due_date || null;
    }
    if ('priority' in b) f.priority = b.priority === 'high' ? 'high' : 'normal';
    // Shop jobs: the customer.
    if ('customer_name' in b) f.customer_name = text(b.customer_name, 'Customer', { required: false, max: 120 }) || null;
    if ('customer_phone' in b) f.customer_phone = text(b.customer_phone, 'Phone', { required: false, max: 40 }) || null;
    if ('job_address' in b) f.job_address = text(b.job_address, 'Address', { required: false, max: 300 }) || null;
    return f;
  }

  app.post('/api/todos', ...L, wrap(async (req, res) => {
    const out = await withTx(async (db) => {
      const f = await readFields(db, req, req.body);
      const steps = (Array.isArray(req.body.steps) ? req.body.steps : []).map((s) => text(s, 'Step', { required: false, max: 300 })).filter(Boolean).slice(0, 100);
      if (!f.title && !f.notes && !steps.length && !f.customer_name) fail(400, 'Type something first');
      const cols = await columns(db, req.household_id);
      let col = cols.find((c) => c.id === Number(req.body.column_id)) || cols[0];
      const isDone = col.id === cols[cols.length - 1].id;
      // Shop jobs get the next job number (per account, from 1001).
      let jobNumber = null;
      if (req.account && req.account.screen === 'shop') {
        await db.query('SELECT pg_advisory_xact_lock(4246, $1)', [req.household_id]);
        jobNumber = (await db.query('SELECT COALESCE(max(job_number), 1000) + 1 AS n FROM todos WHERE household_id=$1', [req.household_id])).rows[0].n;
      }
      const r = await db.query(
        `INSERT INTO todos (household_id, column_id, title, notes, member_id, due_date, priority, done_at, created_by,
           job_number, customer_name, customer_phone, job_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, job_number`,
        [req.household_id, col.id, f.title || '', f.notes || '', f.member_id || null, f.due_date || null, f.priority || 'normal',
          isDone ? new Date() : null, who(req).id, jobNumber, f.customer_name || null, f.customer_phone || null, f.job_address || null]);
      for (const [i, s] of steps.entries()) await db.query('INSERT INTO todo_steps (todo_id, text, position) VALUES ($1,$2,$3)', [r.rows[0].id, s, i + 1]);
      await log(db, r.rows[0].id, req, `Created in ${col.name}`);
      return r.rows[0];
    });
    notify(req.household_id, { type: 'todo', id: out.id });
    res.json(out);
  }));

  app.get('/api/todos/:id', ...L, wrap(async (req, res) => {
    const { todo, cols } = await loadTodo(pool, req.params.id, req.household_id);
    const steps = await pool.query('SELECT * FROM todo_steps WHERE todo_id=$1 ORDER BY position, id', [todo.id]);
    const history = await pool.query('SELECT * FROM todo_history WHERE todo_id=$1 ORDER BY id DESC LIMIT 200', [todo.id]);
    res.json({ ...todo, column: cols[todo.column_index], columns_count: cols.length,
      columns: cols.map((c) => ({ id: c.id, name: c.name, color: c.color })), steps: steps.rows, history: history.rows });
  }));

  app.patch('/api/todos/:id', ...L, wrap(async (req, res) => {
    await withTx(async (db) => {
      const { todo } = await loadTodo(db, req.params.id, req.household_id, true);
      const f = await readFields(db, req, req.body);
      const keys = Object.keys(f);
      if (!keys.length) return;
      await db.query(`UPDATE todos SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')}, updated_at=now() WHERE id=$${keys.length + 1}`,
        [...keys.map((k) => f[k]), todo.id]);
      if ('title' in f && f.title !== todo.title) await logEdit(db, todo.id, req, 'Edited the title');
      if ('notes' in f && f.notes !== todo.notes) await logEdit(db, todo.id, req, 'Edited the notes');
      if ('member_id' in f && f.member_id !== todo.member_id) {
        const m = f.member_id ? await memberName(db, req.household_id, f.member_id) : null;
        await log(db, todo.id, req, m ? `For ${m.name}` : 'For anyone');
      }
      if ('due_date' in f && (f.due_date || null) !== (todo.due_date || null)) await log(db, todo.id, req, f.due_date ? `Due ${niceDate(f.due_date)}` : 'Due date removed');
      if (['customer_name', 'customer_phone', 'job_address'].some((k) => k in f && (f[k] || null) !== (todo[k] || null))) await logEdit(db, todo.id, req, 'Edited the customer details');
      if ('priority' in f && f.priority !== todo.priority) await log(db, todo.id, req, f.priority === 'high' ? 'Marked high priority' : 'Priority set to normal');
    });
    notify(req.household_id, { type: 'todo', id: Number(req.params.id), by: req.body.screen || null });
    res.json({ ok: true });
  }));

  app.delete('/api/todos/:id', ...L, wrap(async (req, res) => {
    const r = await pool.query('DELETE FROM todos WHERE id=$1 AND household_id=$2 RETURNING id', [Number(req.params.id) || 0, req.household_id]);
    if (!r.rows[0]) fail(404, 'That to-do was not found');
    notify(req.household_id, { type: 'todo', id: Number(req.params.id), deleted: true });
    res.json({ ok: true });
  }));

  // Move to any column (column_id) or one step left/right (direction ±1).
  app.post('/api/todos/:id/move', ...L, wrap(async (req, res) => {
    await withTx(async (db) => {
      const { todo, cols } = await loadTodo(db, req.params.id, req.household_id, true);
      let to;
      if (req.body.column_id) {
        to = cols.findIndex((c) => c.id === Number(req.body.column_id));
        if (to < 0) fail(404, 'Column not found');
      } else {
        to = todo.column_index + (Number(req.body.direction) < 0 ? -1 : 1);
        if (to < 0 || to >= cols.length) fail(400, Number(req.body.direction) < 0 ? 'This is already the first column' : 'This is already the last column');
      }
      await placeIn(db, todo, cols, to, req);
    });
    notify(req.household_id, { type: 'todo', id: Number(req.params.id) });
    res.json({ ok: true });
  }));

  // A card button: marks the to-do with the button's name, and with "Mark + move" sends it to the next column.
  // Pressing the button that's already on clears the mark.
  app.post('/api/todos/:id/button', ...L, wrap(async (req, res) => {
    let moved = false;
    await withTx(async (db) => {
      const { todo, cols } = await loadTodo(db, req.params.id, req.household_id, true);
      const col = cols[todo.column_index];
      const btn = (col.buttons || [])[Number(req.body.index)];
      if (!btn || !btn.enabled) fail(400, 'That button is not turned on for this column');
      if (btn.action === 'next' && todo.column_index < cols.length - 1) {
        await log(db, todo.id, req, `${btn.label} (in ${col.name})`);
        await placeIn(db, todo, cols, todo.column_index + 1, req);
        moved = true;
        return;
      }
      const off = todo.status_label === btn.label;
      await db.query('UPDATE todos SET status_label=$1, updated_at=now() WHERE id=$2', [off ? null : btn.label, todo.id]);
      await log(db, todo.id, req, off ? `${btn.label} taken off` : `${btn.label} (in ${col.name})`);
    });
    notify(req.household_id, { type: 'todo', id: Number(req.params.id) });
    res.json({ ok: true, moved });
  }));

  // ---------- checklist steps ----------
  app.post('/api/todos/:id/steps', ...L, wrap(async (req, res) => {
    const out = await withTx(async (db) => {
      const { todo } = await loadTodo(db, req.params.id, req.household_id, true);
      const n = await db.query('SELECT count(*)::int AS n, COALESCE(max(position),0) AS p FROM todo_steps WHERE todo_id=$1', [todo.id]);
      if (n.rows[0].n >= 100) fail(400, '100 steps is the most a to-do can have');
      const s = text(req.body.text, 'Step', { max: 300 });
      const r = await db.query('INSERT INTO todo_steps (todo_id, text, position) VALUES ($1,$2,$3) RETURNING *', [todo.id, s, n.rows[0].p + 1]);
      await log(db, todo.id, req, `Added step: ${s}`);
      await db.query('UPDATE todos SET updated_at=now() WHERE id=$1', [todo.id]);
      return r.rows[0];
    });
    notify(req.household_id, { type: 'todo', id: Number(req.params.id) });
    res.json(out);
  }));
  app.patch('/api/todos/:id/steps/:sid', ...L, wrap(async (req, res) => {
    await withTx(async (db) => {
      const { todo } = await loadTodo(db, req.params.id, req.household_id, true);
      const s = await db.query('SELECT * FROM todo_steps WHERE id=$1 AND todo_id=$2', [Number(req.params.sid) || 0, todo.id]);
      if (!s.rows[0]) fail(404, 'Step not found');
      const step = s.rows[0];
      const t = 'text' in req.body ? text(req.body.text, 'Step', { max: 300 }) : step.text;
      const done = 'done' in req.body ? !!req.body.done : step.done;
      await db.query('UPDATE todo_steps SET text=$1, done=$2 WHERE id=$3', [t, done, step.id]);
      if (done !== step.done) await log(db, todo.id, req, `${done ? '✓ Checked' : 'Unchecked'}: ${t}`);
      else if (t !== step.text) await logEdit(db, todo.id, req, 'Edited a step');
      await db.query('UPDATE todos SET updated_at=now() WHERE id=$1', [todo.id]);
    });
    notify(req.household_id, { type: 'todo', id: Number(req.params.id) });
    res.json({ ok: true });
  }));
  app.delete('/api/todos/:id/steps/:sid', ...L, wrap(async (req, res) => {
    await withTx(async (db) => {
      const { todo } = await loadTodo(db, req.params.id, req.household_id, true);
      const s = await db.query('DELETE FROM todo_steps WHERE id=$1 AND todo_id=$2 RETURNING text', [Number(req.params.sid) || 0, todo.id]);
      if (!s.rows[0]) fail(404, 'Step not found');
      await log(db, todo.id, req, `Removed step: ${s.rows[0].text}`);
      await db.query('UPDATE todos SET updated_at=now() WHERE id=$1', [todo.id]);
    });
    notify(req.household_id, { type: 'todo', id: Number(req.params.id) });
    res.json({ ok: true });
  }));

  return { notify };
};
