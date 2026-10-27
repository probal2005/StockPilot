// D1 schema bootstrap + one-time demo seed. Runs lazily on the first API
// request in each isolate so a fresh database provisions itself.

import { DEMO_ACCOUNTS, hashPassword } from './auth.js'

export const DDL = `
CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sku           TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  category      TEXT    NOT NULL DEFAULT 'Uncategorized',
  description   TEXT    NOT NULL DEFAULT '',
  image_url     TEXT    NOT NULL DEFAULT '',   -- optional photo link (blank = generated artwork)
  image_data    TEXT    NOT NULL DEFAULT '',   -- uploaded photo bytes, base64 (blank = none)
  image_type    TEXT    NOT NULL DEFAULT '',   -- mime type of image_data
  unit          TEXT    NOT NULL DEFAULT 'pcs',
  cost_price    REAL    NOT NULL DEFAULT 0,
  sale_price    REAL    NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 10,
  quantity      INTEGER NOT NULL DEFAULT 0,
  supplier      TEXT    NOT NULL DEFAULT '',
  location      TEXT    NOT NULL DEFAULT '',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  type          TEXT    NOT NULL CHECK (type IN ('in', 'out', 'adjust')),
  quantity      INTEGER NOT NULL,
  unit_cost     REAL    NOT NULL DEFAULT 0,
  reference     TEXT    NOT NULL DEFAULT '',
  note          TEXT    NOT NULL DEFAULT '',
  balance_after INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_quantity ON products(quantity);
CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_movements_created ON stock_movements(created_at);
CREATE INDEX IF NOT EXISTS idx_movements_type ON stock_movements(type);

/* ---- purchasing: suppliers, purchase orders and their lines ----------- */

CREATE TABLE IF NOT EXISTS suppliers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL UNIQUE,
  contact        TEXT    NOT NULL DEFAULT '',
  email          TEXT    NOT NULL DEFAULT '',
  phone          TEXT    NOT NULL DEFAULT '',
  lead_time_days INTEGER NOT NULL DEFAULT 7,
  notes          TEXT    NOT NULL DEFAULT '',
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reference     TEXT    NOT NULL UNIQUE,
  supplier_id   INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_name TEXT    NOT NULL DEFAULT '',   -- snapshot: survives deleting the supplier
  status        TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','partial','received','cancelled')),
  expected_at   TEXT,
  notes         TEXT    NOT NULL DEFAULT '',
  created_by    TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  ordered_at    TEXT,
  received_at   TEXT,
  cancelled_at  TEXT,
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id        INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku          TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  unit         TEXT    NOT NULL DEFAULT 'pcs',
  quantity     INTEGER NOT NULL,
  received_qty INTEGER NOT NULL DEFAULT 0,
  unit_cost    REAL    NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_po_lines_po ON purchase_order_lines(po_id);
CREATE INDEX IF NOT EXISTS idx_po_lines_product ON purchase_order_lines(product_id);

/* ---- cycle counting: a count sheet, then one batched posting ---------- */

CREATE TABLE IF NOT EXISTS stock_counts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  reference  TEXT    NOT NULL UNIQUE,
  scope      TEXT    NOT NULL DEFAULT 'all',
  status     TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','posted','cancelled')),
  notes      TEXT    NOT NULL DEFAULT '',
  created_by TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  posted_at  TEXT
);

CREATE TABLE IF NOT EXISTS stock_count_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  count_id    INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku         TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  unit        TEXT    NOT NULL DEFAULT 'pcs',
  system_qty  INTEGER NOT NULL DEFAULT 0,
  counted_qty INTEGER,
  note        TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_counts_status ON stock_counts(status);
CREATE INDEX IF NOT EXISTS idx_count_lines_count ON stock_count_lines(count_id);
CREATE INDEX IF NOT EXISTS idx_count_lines_product ON stock_count_lines(product_id);

CREATE TABLE IF NOT EXISTS admin_users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  name            TEXT    NOT NULL DEFAULT '',
  role            TEXT    NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'operator', 'viewer')),
  password_hash   TEXT    NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  last_login_at   TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT    NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT    NOT NULL,
  last_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
  revoked_at   TEXT,
  ip           TEXT    NOT NULL DEFAULT '',
  user_agent   TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS auth_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  email      TEXT NOT NULL DEFAULT '',
  event      TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_events_at ON auth_events(at);
`

/** 26 demo products: [sku, name, category, unit, cost, sale, reorder, supplier] */
const CATALOG = [
  ['ELC-1001', 'Wireless Mouse Pro', 'Electronics', 'pcs', 11.5, 24.99, 25, 'Kestrel Peripherals'],
  ['ELC-1002', 'Mechanical Keyboard TKL', 'Electronics', 'pcs', 42.0, 89.0, 15, 'Kestrel Peripherals'],
  ['ELC-1003', 'USB-C Hub 8-in-1', 'Electronics', 'pcs', 18.75, 44.5, 20, 'Northwind Tech'],
  ['ELC-1004', '27" QHD Monitor', 'Electronics', 'pcs', 168.0, 289.0, 8, 'Northwind Tech'],
  ['ELC-1005', 'Noise-Cancelling Headphones', 'Electronics', 'pcs', 96.0, 199.0, 10, 'Auralux Audio'],
  ['ELC-1006', 'Webcam 1080p', 'Electronics', 'pcs', 27.4, 59.0, 18, 'Northwind Tech'],
  ['ELC-1007', 'Portable SSD 1TB', 'Electronics', 'pcs', 74.0, 129.0, 12, 'Vault Drive Co'],
  ['ELC-1008', 'Bluetooth Speaker Mini', 'Electronics', 'pcs', 21.0, 49.9, 20, 'Auralux Audio'],
  ['ACC-2001', 'Laptop Sleeve 14"', 'Accessories', 'pcs', 8.2, 21.0, 30, 'Ridgeway Goods'],
  ['ACC-2002', 'Desk Mat XL', 'Accessories', 'pcs', 9.6, 26.0, 25, 'Ridgeway Goods'],
  ['ACC-2003', 'Cable Organizer Set', 'Accessories', 'set', 3.4, 11.5, 40, 'Ridgeway Goods'],
  ['ACC-2004', 'Aluminium Phone Stand', 'Accessories', 'pcs', 5.9, 17.0, 35, 'Ridgeway Goods'],
  ['ACC-2005', 'Laptop Riser Stand', 'Accessories', 'pcs', 14.8, 39.0, 15, 'Ridgeway Goods'],
  ['OFF-3001', 'A4 Paper Ream 80gsm', 'Office Supplies', 'ream', 3.95, 7.5, 60, 'Papermill Direct'],
  ['OFF-3002', 'Ballpoint Pens (Box of 50)', 'Office Supplies', 'box', 6.5, 14.0, 30, 'Inkwell Stationers'],
  ['OFF-3003', 'Sticky Notes 76mm', 'Office Supplies', 'pack', 1.85, 5.25, 50, 'Inkwell Stationers'],
  ['OFF-3004', 'Heavy Duty Stapler', 'Office Supplies', 'pcs', 9.3, 22.0, 20, 'Inkwell Stationers'],
  ['OFF-3005', 'Whiteboard Marker Set', 'Office Supplies', 'set', 4.1, 12.75, 25, 'Inkwell Stationers'],
  ['OFF-3006', 'Archive Filing Box', 'Office Supplies', 'pcs', 2.6, 8.0, 45, 'Papermill Direct'],
  ['NET-4001', 'Wi-Fi 6 Router AX3000', 'Networking', 'pcs', 78.5, 149.0, 10, 'Linkwave Systems'],
  ['NET-4002', 'Cat6 Ethernet Cable 5m', 'Networking', 'pcs', 4.3, 12.5, 40, 'Linkwave Systems'],
  ['NET-4003', '8-Port Gigabit Switch', 'Networking', 'pcs', 32.0, 69.0, 12, 'Linkwave Systems'],
  ['NET-4004', 'Powerline Adapter Kit', 'Networking', 'kit', 41.0, 84.0, 8, 'Linkwave Systems'],
  ['STO-5001', 'External HDD 2TB', 'Storage', 'pcs', 58.0, 99.0, 10, 'Vault Drive Co'],
  ['STO-5002', 'MicroSD Card 128GB', 'Storage', 'pcs', 12.4, 28.0, 35, 'Vault Drive Co'],
  ['STO-5003', 'USB Flash Drive 64GB', 'Storage', 'pcs', 6.1, 16.5, 45, 'Vault Drive Co'],
]

const WAREHOUSES = ['Aisle A-1', 'Aisle A-2', 'Aisle B-1', 'Aisle B-2', 'Aisle C-1', 'Overflow Bay']
const CUSTOMERS = ['Acme Retail', 'Brightline Ltd', 'Corner Store #12', 'Delta Systems', 'Everest Trading', 'Fairview Campus']
const SUPPLIER_REF = 'PO-2026-'

/** Deterministic PRNG so every fresh database seeds the same demo history. */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const dayOffset = (days, hour, minute) => {
  const d = new Date(Date.now() - days * 86400000)
  d.setUTCHours(hour, minute, 0, 0)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/** Build the INSERT statements for a realistic 45-day movement history. */
export function buildSeedStatements() {
  const rand = mulberry32(20261012)
  const pick = (arr) => arr[Math.floor(rand() * arr.length)]
  const between = (min, max) => Math.floor(rand() * (max - min + 1)) + min

  const statements = []
  const history = []

  // Products with a deliberately thin stock position so alerts are visible.
  const lowStockTargets = new Set([2, 4, 14, 22, 24])

  CATALOG.forEach((row, index) => {
    const [sku, name, category, unit, cost, sale, reorder, supplier] = row
    const productId = index + 1
    const product = {
      id: productId,
      sku,
      name,
      category,
      cost,
      reorder,
      location: WAREHOUSES[index % WAREHOUSES.length],
    }

    let balance = 0
    // Opening stock received 45 days ago.
    const opening = between(reorder * 2, reorder * 5)
    balance += opening
    history.push({
      productId,
      type: 'in',
      quantity: opening,
      unitCost: cost,
      reference: `${SUPPLIER_REF}${1000 + productId}`,
      note: 'Opening stock receipt',
      balanceAfter: balance,
      createdAt: dayOffset(45, 9, between(0, 59)),
    })

    const events = between(5, 11)
    for (let i = 0; i < events; i += 1) {
      const daysAgo = between(1, 44)
      const isRestock = rand() < 0.32
      if (isRestock) {
        const qty = between(Math.ceil(reorder / 2), reorder * 2)
        balance += qty
        history.push({
          productId,
          type: 'in',
          quantity: qty,
          unitCost: cost,
          reference: `${SUPPLIER_REF}${2000 + productId * 10 + i}`,
          note: `Restock from ${supplier}`,
          balanceAfter: balance,
          createdAt: dayOffset(daysAgo, between(8, 17), between(0, 59)),
        })
      } else {
        const qty = between(1, Math.max(2, Math.ceil(reorder / 3)))
        if (qty > balance) continue
        balance -= qty
        history.push({
          productId,
          type: 'out',
          quantity: qty,
          unitCost: sale,
          reference: `SO-${5000 + productId * 10 + i}`,
          note: `Sold to ${pick(CUSTOMERS)}`,
          balanceAfter: balance,
          createdAt: dayOffset(daysAgo, between(8, 18), between(0, 59)),
        })
      }
    }

    // Force a few products into low / out-of-stock territory for the alert feed.
    if (lowStockTargets.has(productId)) {
      const wantLow = rand() < 0.4
      const target = wantLow ? 0 : Math.max(1, Math.floor(reorder * (0.25 + rand() * 0.6)))
      if (target < balance) {
        const qty = balance - target
        balance = target
        history.push({
          productId,
          type: 'adjust',
          quantity: qty,
          unitCost: cost,
          reference: `STOCKTAKE-${productId}`,
          note: 'Cycle count shrinkage adjustment',
          balanceAfter: balance,
          createdAt: dayOffset(between(1, 6), between(9, 16), between(0, 59)),
        })
      }
    }

    product.quantity = balance
    statements.push({ product, history: history.filter((h) => h.productId === productId) })
  })

  return statements
}

/* ==========================================================================
   Purchasing seed: the demo catalogue already names its suppliers in free
   text, so the first run turns those names into real supplier records with
   contacts and lead times, links the products, and opens a couple of live
   purchase orders so the purchasing screens have something in them.
   ========================================================================== */

/** [name, contact, email, phone, lead_time_days, notes] */
const SUPPLIER_CATALOG = [
  ['Kestrel Peripherals', 'Dana Whitfield', 'orders@kestrelperipherals.example', '+1 555 0142', 5, 'Peripherals OEM. Net 30, free freight above $2,000.'],
  ['Northwind Tech', 'Marcus Feld', 'purchasing@northwindtech.example', '+1 555 0188', 7, 'Displays and hubs. Ships weekly on Tuesdays.'],
  ['Auralux Audio', 'Priya Raman', 'sales@auraluxaudio.example', '+1 555 0117', 12, 'Long lead on sealed audio lines — order ahead of season.'],
  ['Vault Drive Co', 'Tom Ilesanmi', 'trade@vaultdrive.example', '+1 555 0163', 3, 'Storage media. Fastest turnaround of our vendors.'],
  ['Ridgeway Goods', 'Elena Sorensen', 'orders@ridgewaygoods.example', '+1 555 0129', 10, 'Desk and travel accessories. Mixed pallets allowed.'],
  ['Papermill Direct', 'Joe Karimi', 'hello@papermilldirect.example', '+1 555 0154', 2, 'Paper and filing. Next-day on local stock.'],
  ['Inkwell Stationers', 'Sara Lindqvist', 'accounts@inkwellstationers.example', '+1 555 0176', 4, 'Stationery consumables. Standing order monthly.'],
  ['Linkwave Systems', 'Hugo Marchetti', 'ops@linkwavesystems.example', '+1 555 0193', 14, 'Networking hardware. Import lead time is fixed — plan ahead.'],
]

const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 22)

/**
 * Suppliers, product links and a small live book of orders. Runs once, on a
 * database that has products but no suppliers yet, so it also upgrades a
 * database created before purchasing existed.
 */
export async function seedPurchasing(env) {
  const { results: existing } = await env.DB.prepare('SELECT COUNT(*) AS n FROM suppliers').all()
  if ((existing?.[0]?.n ?? 0) > 0) return

  const statements = []
  const ids = {}
  for (const [name, contact, email, phone, lead, notes] of SUPPLIER_CATALOG) {
    const result = await env.DB.prepare(
      `INSERT INTO suppliers (name, contact, email, phone, lead_time_days, notes, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(name, contact, email, phone, lead, notes, dayOffset(46, 8, 0), dayOffset(46, 8, 0)).run()
    ids[name] = result.meta?.last_row_id
  }

  // Link every product whose free-text supplier matches a seeded name.
  for (const [name, id] of Object.entries(ids)) {
    statements.push(
      env.DB.prepare('UPDATE products SET supplier_id = ? WHERE supplier = ? AND supplier_id IS NULL').bind(id, name),
    )
  }
  if (statements.length) await env.DB.batch(statements)

  /* Two live purchase orders: one plain, one part-received, so the screens
     show both states on a fresh install. */
  const { results: products } = await env.DB.prepare(
    'SELECT id, sku, name, unit, cost_price FROM products',
  ).all()
  const bySku = Object.fromEntries((products ?? []).map((p) => [p.sku, p]))

  const openPo = async (reference, supplierName, expectedInDays, note, lines) => {
    const created = await env.DB.prepare(
      `INSERT INTO purchase_orders (reference, supplier_id, supplier_name, status, expected_at, notes, created_by, created_at, ordered_at, updated_at)
       VALUES (?, ?, ?, 'ordered', ?, ?, 'system seed', ?, ?, ?)`,
    ).bind(reference, ids[supplierName], supplierName, dayOffset(-expectedInDays, 17, 0).slice(0, 10), note,
      dayOffset(9, 10, 30).slice(0, 19), dayOffset(9, 10, 30).slice(0, 19), dayOffset(9, 10, 30).slice(0, 19)).run()
    const poId = created.meta?.last_row_id
    for (const [sku, quantity, unitCost, received] of lines) {
      const p = bySku[sku]
      if (!p) continue
      await env.DB.prepare(
        `INSERT INTO purchase_order_lines (po_id, product_id, sku, name, unit, quantity, received_qty, unit_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(poId, p.id, p.sku, p.name, p.unit, quantity, received ?? 0, unitCost ?? p.cost_price).run()
    }
  }

  await openPo('PO-2026-3101', 'Vault Drive Co', 3, 'Restock ahead of the quarter end push.', [
    ['STO-5001', 20, 58.0, 0],
    ['STO-5002', 60, 12.4, 0],
    ['STO-5003', 100, 6.1, 0],
  ])
  await openPo('PO-2026-3102', 'Papermill Direct', 6, 'Paper and filing top-up; the ream line landed in two drops.', [
    ['OFF-3001', 120, 3.95, 60],
    ['OFF-3006', 80, 2.6, 80],
  ])
  // Any order that is part-received reads as `partial`, not `ordered`.
  await env.DB.prepare(
    `UPDATE purchase_orders SET status = 'partial'
      WHERE id IN (SELECT po_id FROM purchase_order_lines GROUP BY po_id
                    HAVING SUM(received_qty) > 0 AND SUM(received_qty) < SUM(quantity))`,
  ).run()

  /* A half-finished cycle count, so the count screen opens with variance to
     look at rather than an empty table. Stock is untouched until it is posted. */
  const { results: storage } = await env.DB.prepare(
    "SELECT id, sku, name, unit, quantity FROM products WHERE category = 'Storage' AND is_active = 1 ORDER BY sku",
  ).all()
  if ((storage ?? []).length) {
    const count = await env.DB.prepare(
      `INSERT INTO stock_counts (reference, scope, status, notes, created_by, created_at)
       VALUES ('CNT-2026-0101', 'category:Storage', 'open', 'Quarterly count of the storage aisle — two lines still to check.', 'system seed', ?)`,
    ).bind(dayOffset(2, 9, 15).slice(0, 19)).run()
    const countId = count.meta?.last_row_id
    for (const p of storage) {
      // Deliberately off by a unit or two on two lines so variance is visible.
      const drift = p.sku === 'STO-5001' ? -2 : p.sku === 'STO-5003' ? 3 : 0
      await env.DB.prepare(
        `INSERT INTO stock_count_lines (count_id, product_id, sku, name, unit, system_qty, counted_qty, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(countId, p.id, p.sku, p.name, p.unit, p.quantity,
        drift === 0 ? null : p.quantity + drift,
        drift === 0 ? '' : 'Counted on pallet 3').run()
    }
  }

  console.log(`seeded ${Object.keys(ids).length} suppliers, 2 purchase orders and 1 stock count`)
}

/** The team accounts are seeded independently of the catalogue, so an existing
 * database (or one you emptied) still gets a working admin login. Passwords are
 * hashed here and only the hash is stored.
 */
export async function ensureAccounts(env) {
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_users').all()
  if ((results?.[0]?.n ?? 0) > 0) return 0
  let created = 0
  for (const account of DEMO_ACCOUNTS) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO admin_users (email, name, role, password_hash, is_active)
       VALUES (?, ?, ?, ?, 1)`,
    ).bind(account.email, account.name, account.role, await hashPassword(account.password)).run()
    created += 1
  }
  return created
}

/**
 * Columns added after the first release. D1 has no `ADD COLUMN IF NOT EXISTS`,
 * so the table is inspected first and the migration is skipped when it is
 * already there (or when the table has just been created with the column).
 */
const MIGRATIONS = [
  { table: 'products', column: 'image_url', ddl: `ALTER TABLE products ADD COLUMN image_url TEXT NOT NULL DEFAULT ''` },
  { table: 'products', column: 'image_data', ddl: `ALTER TABLE products ADD COLUMN image_data TEXT NOT NULL DEFAULT ''` },
  { table: 'products', column: 'image_type', ddl: `ALTER TABLE products ADD COLUMN image_type TEXT NOT NULL DEFAULT ''` },
  { table: 'products', column: 'supplier_id', ddl: `ALTER TABLE products ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL` },
]

async function migrate(env) {
  let applied = 0
  for (const migration of MIGRATIONS) {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${migration.table})`).all()
    if ((results ?? []).some((row) => row.name === migration.column)) continue
    await env.DB.prepare(migration.ddl).run()
    applied += 1
    console.log(`migrated ${migration.table}.${migration.column}`)
  }
  return applied
}

export async function ensureSchema(env) {
  // D1's exec() splits on newlines, so the DDL is split on ";" and run as a
  // single transactional batch of prepared statements instead.
  const statements = DDL.split(';').map((s) => s.trim()).filter(Boolean)
  await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)))
  await migrate(env)
  const accounts = await ensureAccounts(env)
  if (accounts) console.log(`seeded ${accounts} admin accounts`)
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM products').all()
  const count = results?.[0]?.n ?? 0
  if (count > 0) {
    // A database seeded before purchasing existed still gets its suppliers.
    await seedPurchasing(env)
    return
  }

  const built = buildSeedStatements()
  const inserts = []
  for (const { product, history } of built) {
    inserts.push(
      env.DB.prepare(
        `INSERT INTO products (id, sku, name, category, description, unit, cost_price, sale_price,
           reorder_level, quantity, supplier, location, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        product.id,
        product.sku,
        product.name,
        product.category,
        `${product.name} — ${product.category} line item.`,
        CATALOG[product.id - 1][3],
        product.cost,
        CATALOG[product.id - 1][5],
        product.reorder,
        product.quantity,
        CATALOG[product.id - 1][7],
        product.location,
        dayOffset(45, 8, 0),
        history.length ? history[history.length - 1].createdAt : dayOffset(45, 8, 0),
      ),
    )
    for (const m of history) {
      inserts.push(
        env.DB.prepare(
          `INSERT INTO stock_movements (product_id, type, quantity, unit_cost, reference, note, balance_after, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(m.productId, m.type, m.quantity, m.unitCost, m.reference, m.note, m.balanceAfter, m.createdAt),
      )
    }
  }
  // Chunked so a large seed never exceeds D1's per-batch statement limits.
  for (let i = 0; i < inserts.length; i += 40) {
    await env.DB.batch(inserts.slice(i, i + 40))
  }
  await seedPurchasing(env)
}
