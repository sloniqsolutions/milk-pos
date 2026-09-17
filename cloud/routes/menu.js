/**
 * The menu — editable from both the dashboard and a paired till.
 *
 * The dashboard writes here directly (the routes just below). A till writes
 * its own SQLite first, same as every other screen, then pushes the saved
 * row up through `POST /api/menu/from-till`, which upserts it by name and
 * re-runs the same universal-price cascade a dashboard edit triggers — see
 * that route's own comment for why matching by name (not id) is what makes
 * this work with no shared id space between a till and this table.
 *
 * Three endpoints exist for the tills:
 *
 *   GET  /api/menu/version    a single integer, a few bytes, asked constantly
 *   GET  /api/menu/snapshot   the whole menu, fetched only when that number moves
 *   POST /api/menu/from-till  a till's own create/update/retire, pushed up
 *
 * A till on a weak link can always afford the version check. It downloads a
 * full snapshot only when that number moves, and if that download fails it
 * simply keeps selling from the menu it already has — the same reasoning
 * that keeps every push here fire-and-forget rather than blocking a save.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/pg');
const { requireUser } = require('../middleware/session');
const { requireBranch } = require('../middleware/branch-auth');
const { cascadeUniversalPricing, derivedPriceFor } = require('../db/menu-pricing');

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v) => (v == null ? null : String(v));

/**
 * Every edit moves the version.
 *
 * Called inside the same transaction as the change itself, so a till can never
 * see a version that promises a menu the cloud did not manage to save.
 */
async function bumpVersion(client) {
  const r = await client.query(
    'UPDATE menu_version SET version = version + 1, updated_at = NOW() WHERE id = 1 RETURNING version');
  return r.rows[0].version;
}

async function currentVersion() {
  const row = await db.one('SELECT version FROM menu_version WHERE id = 1');
  return row ? Number(row.version) : 0;
}

/* ------------------------------------------------------- the dashboard -- */

/** Matches the till's own `GET /api/menu`, so its Menu screen works unchanged. */
router.get('/', requireUser, async (req, res) => {
  const includeInactive = req.query.include_inactive === '1' || req.query.include_inactive === 'true';
  try {
    const items = await db.q(
      `SELECT * FROM menu_items ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY category, name`);
    const variants = await db.q('SELECT * FROM item_variants ORDER BY sort_order');

    const byItem = new Map();
    variants.forEach(v => {
      if (!byItem.has(v.menu_item_id)) byItem.set(v.menu_item_id, []);
      byItem.get(v.menu_item_id).push({
        id: v.id, label: v.label, price: v.price, sort_order: v.sort_order,
      });
    });

    res.json(items.map(item => ({
      ...item,
      variants: item.has_variants ? (byItem.get(item.id) || []) : [],
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireUser, async (req, res) => {
  const { name, category, price, description, has_variants, variants, image_url } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });

  try {
    const result = await db.tx(async (client) => {
      // A sized Milk/Dahi item (e.g. "1.5 Litre", "250g") always prices off
      // the universal item ("1 Litre" / "Dahi") rather than whatever was
      // submitted — see db/menu-pricing.js.
      const derived = has_variants ? null : await derivedPriceFor(client, str(category), str(name));
      const itemPrice = derived != null ? derived : (num(price) || 0);

      const item = await client.query(`
        INSERT INTO menu_items (name, category, price, image_url, has_variants, description, active)
        VALUES ($1, $2, $3, $4, $5, $6, 1) RETURNING *
      `, [str(name), str(category), itemPrice, str(image_url),
          has_variants ? 1 : 0, str(description)]);

      const id = item.rows[0].id;
      if (has_variants && Array.isArray(variants)) {
        for (const [i, v] of variants.entries()) {
          await client.query(
            'INSERT INTO item_variants (menu_item_id, label, price, sort_order) VALUES ($1,$2,$3,$4)',
            [id, str(v.label), num(v.price) || 0, num(v.sort_order) ?? i]);
        }
      }
      const version = await bumpVersion(client);
      return { ...item.rows[0], menu_version: version };
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireUser, async (req, res) => {
  const { name, category, price, description, has_variants, variants, active, image_url } = req.body || {};
  try {
    const result = await db.tx(async (client) => {
      // Same rule as creation: a sized Milk/Dahi item's price always derives
      // from the universal item, overriding whatever was submitted, as long
      // as this request actually names the item (the usual case — the Menu
      // screen always sends name+category+price together).
      const derived = (!has_variants && name && category)
        ? await derivedPriceFor(client, str(category), str(name))
        : null;
      const effectivePrice = derived != null ? derived : num(price);

      const item = await client.query(`
        UPDATE menu_items SET
          name = COALESCE($1, name),
          category = COALESCE($2, category),
          price = COALESCE($3, price),
          image_url = COALESCE($4, image_url),
          has_variants = COALESCE($5, has_variants),
          description = COALESCE($6, description),
          active = COALESCE($7, active)
        WHERE id = $8 RETURNING *
      `, [str(name), str(category), effectivePrice, str(image_url),
          has_variants == null ? null : (has_variants ? 1 : 0),
          str(description), active == null ? null : (active ? 1 : 0), req.params.id]);

      if (!item.rows.length) return null;

      // Variants are replaced wholesale rather than diffed: the screen sends the
      // complete list, and matching them up by hand would be guesswork.
      if (Array.isArray(variants)) {
        await client.query('DELETE FROM item_variants WHERE menu_item_id = $1', [req.params.id]);
        for (const [i, v] of variants.entries()) {
          await client.query(
            'INSERT INTO item_variants (menu_item_id, label, price, sort_order) VALUES ($1,$2,$3,$4)',
            [req.params.id, str(v.label), num(v.price) || 0, num(v.sort_order) ?? i]);
        }
      }
      // If this was the "1 Litre" or "Dahi" universal-price item, every other
      // sized item in that category is re-priced off it — see db/menu-pricing.js.
      await cascadeUniversalPricing(client, item.rows[0]);
      const version = await bumpVersion(client);
      return { ...item.rows[0], menu_version: version };
    });

    if (!result) return res.status(404).json({ error: 'Menu item not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Retire an item rather than deleting it.
 *
 * Exactly as the till does. Sales reporting joins order_items back to the menu,
 * so a hard delete would take the category off every past order — rewriting
 * figures that have already been reported and exported. Retired items vanish
 * from the menu and still resolve for reporting.
 */
router.delete('/:id', requireUser, async (req, res) => {
  try {
    const result = await db.tx(async (client) => {
      const r = await client.query(
        'UPDATE menu_items SET active = 0 WHERE id = $1 RETURNING id', [req.params.id]);
      if (!r.rows.length) return null;
      await bumpVersion(client);
      return true;
    });
    if (!result) return res.status(404).json({ error: 'Menu item not found' });
    res.json({ success: true, retired: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------- the tills -- */

/**
 * POST /api/menu/from-till — a till pushing its own create/update/retire.
 *
 * Upserted by *name*, not id: a till's menu_items ids are its own plain
 * SQLite AUTOINCREMENT, unrelated to this table's — the same reason
 * backend/sync/downlink.js's applyMenu() matches the other direction by name
 * too. `variants` is only touched when the till actually sent an array —
 * omitted on a retire/restore push, which only means the active flag, so it
 * leaves whatever variants this row already had alone rather than deleting
 * them.
 *
 * Runs the identical cascade a dashboard edit triggers, so a till-side
 * change to "1 Litre" reprices "0.5 Litre"/"2 Litre" here exactly as it
 * would if the owner had typed it into the dashboard — the pushing till
 * picks that up on its own next downlink poll, same as every other till.
 */
router.post('/from-till', requireBranch, async (req, res) => {
  const { name, category, price, description, has_variants, active, variants } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });

  try {
    const result = await db.tx(async (client) => {
      const existing = await client.query('SELECT * FROM menu_items WHERE name = $1', [str(name)]);
      let item;
      if (existing.rows.length) {
        const updated = await client.query(`
          UPDATE menu_items SET
            category = $1, price = $2, description = $3, has_variants = $4, active = $5
          WHERE id = $6 RETURNING *
        `, [str(category), num(price) || 0, str(description), has_variants ? 1 : 0,
            active == null ? 1 : (active ? 1 : 0), existing.rows[0].id]);
        item = updated.rows[0];
      } else {
        const inserted = await client.query(`
          INSERT INTO menu_items (name, category, price, description, has_variants, active)
          VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
        `, [str(name), str(category), num(price) || 0, str(description), has_variants ? 1 : 0,
            active == null ? 1 : (active ? 1 : 0)]);
        item = inserted.rows[0];
      }

      if (Array.isArray(variants)) {
        await client.query('DELETE FROM item_variants WHERE menu_item_id = $1', [item.id]);
        for (const [i, v] of variants.entries()) {
          await client.query(
            'INSERT INTO item_variants (menu_item_id, label, price, sort_order) VALUES ($1,$2,$3,$4)',
            [item.id, str(v.label), num(v.price) || 0, num(v.sort_order) ?? i]);
        }
      }

      await cascadeUniversalPricing(client, item);
      const version = await bumpVersion(client);
      return version;
    });
    res.json({ success: true, menu_version: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/menu/version — a few bytes, asked constantly.
 *
 * Open to a branch key rather than a session: this is a till asking.
 */
router.get('/version', requireBranch, async (req, res) => {
  try {
    res.json({ version: await currentVersion() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/menu/snapshot — the whole menu, in db/menu-data.js's shape.
 *
 * A whole snapshot, never a diff. Diffs have to arrive in order and in full;
 * a snapshot either applies or it does not, and missing three of them is the
 * same as missing one. On a link that drops mid-download that difference is
 * the whole game.
 *
 * The version is returned *with* the document so the till records exactly what
 * it applied, rather than whatever the version happens to be by the time it
 * finishes writing.
 */
router.get('/snapshot', requireBranch, async (req, res) => {
  try {
    const version = await currentVersion();
    const items = await db.q('SELECT * FROM menu_items WHERE active = 1 ORDER BY category, name');
    const variants = await db.q('SELECT * FROM item_variants ORDER BY sort_order');
    const deals = await db.q('SELECT * FROM deals WHERE active = 1 ORDER BY name');
    const dealItems = await db.q(`
      SELECT di.deal_id, di.quantity, di.description,
             mi.name AS item_name, iv.label AS variant_label
        FROM deal_items di
        LEFT JOIN menu_items mi ON mi.id = di.menu_item_id
        LEFT JOIN item_variants iv ON iv.id = di.variant_id
       ORDER BY di.id
    `);

    const variantsByItem = new Map();
    variants.forEach(v => {
      if (!variantsByItem.has(v.menu_item_id)) variantsByItem.set(v.menu_item_id, []);
      variantsByItem.get(v.menu_item_id).push(v);
    });

    // The till's applyMenu() links deal lines by *name*, not by id, precisely
    // because ids differ per machine. So the snapshot speaks in names.
    const linesByDeal = new Map();
    dealItems.forEach(d => {
      if (!d.item_name) return;
      if (!linesByDeal.has(d.deal_id)) linesByDeal.set(d.deal_id, []);
      linesByDeal.get(d.deal_id).push([d.item_name, d.quantity || 1, d.variant_label || null]);
    });

    res.json({
      version,
      MENU: items.map(i => ({
        n: i.name,
        c: i.category,
        p: i.price,
        d: i.description || undefined,
        v: i.has_variants
          ? (variantsByItem.get(i.id) || []).map(v => [v.label, v.price])
          : undefined,
      })),
      DEALS: deals.map(d => ({
        n: d.name,
        d: d.description || '',
        p: d.price,
        g: d.deal_group,
        items: linesByDeal.get(d.id) || [],
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.currentVersion = currentVersion;
module.exports.bumpVersion = bumpVersion;
