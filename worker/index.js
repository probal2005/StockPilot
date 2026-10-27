// Smart Inventory Management System — Workers + D1 API with static asset fallback.
import { HttpError, json } from './lib.js'
import { ensureSchema } from './schema.js'
import {
  createProduct, deleteProduct, exportCsv, getProduct, listCategories, listProducts,
  productImage, restoreProduct, updateProduct,
} from './products.js'
import { createBulkMovements, createMovement, deleteMovement, listMovements } from './stock.js'
import {
  createOrdersFromSuggestions, createPurchaseOrder, createSupplier, deletePurchaseOrder, deleteSupplier,
  exportProcureCsv, getPurchaseOrder, getSupplier, listPurchaseOrders, listSuppliers, purchasingSuggestions,
  purchasingSummary, receivePurchaseOrder, transitionPurchaseOrder, updatePurchaseOrder, updateSupplier,
} from './procure.js'
import {
  createCount, deleteCount, exportCountCsv, getCount, listCounts, postCount, updateCount,
} from './counts.js'
import { alerts, dashboard, reportActivity, reportHealth, reportMovement, reportSummary, reportValuation } from './insights.js'
import { reportPdf } from './report-pdf.js'
import {
  COOKIE, assertSameOrigin, can, changePassword, createSession, currentUser, demoAccounts, listAccounts,
  listEvents, login, logout, recordEvent, revokeSessions, sessionInfo, unlockAccount,
} from './auth.js'

// Schema bootstrap runs once per isolate and is memoised; a failure clears the
// memo so the next request can retry rather than caching the error forever.
let schemaPromise = null
function bootstrap(env) {
  if (!schemaPromise) {
    schemaPromise = ensureSchema(env).catch((err) => {
      schemaPromise = null
      throw err
    })
  }
  return schemaPromise
}

/* Routes carry the capability they need; nothing is authenticated by accident.
   Capabilities: public → read → move → manage → admin (see ROLE_CAPABILITIES). */
const ROUTES = [
  ['GET', /^\/api\/health$/, (_env, _m, _body, url) => json({ ok: true, service: 'smart-inventory', at: new Date().toISOString(), seeded: url.searchParams.get('full') === '1' }), 'public'],

  /* --- authentication --- */
  ['POST', /^\/api\/auth\/login$/, (env, m, _b, url) => login(env, m.request, url), 'public'],
  ['GET', /^\/api\/auth\/demo$/, (env) => demoAccounts(env), 'public'],
  ['GET', /^\/api\/auth\/session$/, (env, m) => sessionInfo(env, m.request, m.user), 'public'],
  ['POST', /^\/api\/auth\/logout$/, (env, m, _b, url) => logout(env, m.request, m.user, url), 'public'],
  ['POST', /^\/api\/auth\/password$/, (env, m, _b, url) => changePassword(env, m.request, m.user, url), 'read'],
  ['GET', /^\/api\/auth\/accounts$/, (env) => listAccounts(env), 'admin'],
  ['GET', /^\/api\/auth\/events$/, (env, _m, _b, url) => listEvents(env, url), 'admin'],
  ['POST', /^\/api\/auth\/unlock$/, (env, m) => unlockAccount(env, m.request, m.user), 'admin'],
  ['POST', /^\/api\/auth\/revoke$/, (env, m) => revokeSessions(env, m.request, m.user), 'admin'],

  /* --- reads --- */
  ['GET', /^\/api\/dashboard$/, (env, _m, _b, url) => dashboard(env, url), 'read'],
  ['GET', /^\/api\/alerts$/, (env, _m, _b, url) => alerts(env, url), 'read'],
  ['GET', /^\/api\/categories$/, (env) => listCategories(env), 'read'],
  ['GET', /^\/api\/export\.csv$/, (env, _m, _b, url) => exportCsv(env, url), 'read'],
  ['GET', /^\/api\/report\.pdf$/, (env, m, _b, url) => downloadReport(env, m.request, url, m.user), 'read'],
  ['GET', /^\/api\/reports\/summary$/, (env, _m, _b, url) => reportSummary(env, url), 'read'],
  ['GET', /^\/api\/reports\/valuation$/, (env, _m, _b, url) => reportValuation(env, url), 'read'],
  ['GET', /^\/api\/reports\/movement$/, (env, _m, _b, url) => reportMovement(env, url), 'read'],
  ['GET', /^\/api\/reports\/health$/, (env, _m, _b, url) => reportHealth(env, url), 'read'],
  ['GET', /^\/api\/reports\/activity$/, (env, _m, _b, url) => reportActivity(env, url), 'read'],
  ['GET', /^\/api\/products$/, (env, _m, _b, url) => listProducts(env, url), 'read'],
  ['GET', /^\/api\/products\/(\d+)$/, (env, m) => getProduct(env, Number(m.params[0])), 'read'],
  ['GET', /^\/api\/products\/(\d+)\/image$/, (env, m) => productImage(env, Number(m.params[0])), 'read'],
  ['GET', /^\/api\/movements$/, (env, _m, _b, url) => listMovements(env, url), 'read'],

  /* --- procurement: suppliers, purchase orders, replenishment --- */
  ['GET', /^\/api\/suppliers$/, (env, _m, _b, url) => listSuppliers(env, url), 'read'],
  ['GET', /^\/api\/suppliers\/(\d+)$/, (env, m) => getSupplier(env, Number(m.params[0])), 'read'],
  ['POST', /^\/api\/suppliers$/, (env, m) => createSupplier(env, m.request), 'manage'],
  ['PUT', /^\/api\/suppliers\/(\d+)$/, (env, m) => updateSupplier(env, Number(m.params[0]), m.request), 'move'],
  ['PATCH', /^\/api\/suppliers\/(\d+)$/, (env, m) => updateSupplier(env, Number(m.params[0]), m.request), 'move'],
  ['DELETE', /^\/api\/suppliers\/(\d+)$/, (env, m, _b, url) => deleteSupplier(env, Number(m.params[0]), url), 'manage'],

  ['GET', /^\/api\/purchase-orders$/, (env, _m, _b, url) => listPurchaseOrders(env, url), 'read'],
  ['GET', /^\/api\/purchase-orders\/(\d+)$/, (env, m) => getPurchaseOrder(env, Number(m.params[0])), 'read'],
  ['POST', /^\/api\/purchase-orders$/, (env, m) => createPurchaseOrder(env, m.request, m.user), 'manage'],
  ['PUT', /^\/api\/purchase-orders\/(\d+)$/, (env, m) => updatePurchaseOrder(env, Number(m.params[0]), m.request), 'move'],
  ['PATCH', /^\/api\/purchase-orders\/(\d+)$/, (env, m) => updatePurchaseOrder(env, Number(m.params[0]), m.request), 'move'],
  ['POST', /^\/api\/purchase-orders\/(\d+)\/transition$/, (env, m, _b, url) => transitionPurchaseOrder(env, Number(m.params[0]), m.request, url), 'move'],
  ['POST', /^\/api\/purchase-orders\/(\d+)\/receive$/, (env, m) => receivePurchaseOrder(env, Number(m.params[0]), m.request), 'move'],
  ['DELETE', /^\/api\/purchase-orders\/(\d+)$/, (env, m, _b, url) => deletePurchaseOrder(env, Number(m.params[0]), url), 'manage'],

  ['GET', /^\/api\/purchasing\/suggestions$/, (env, _m, _b, url) => purchasingSuggestions(env, url), 'read'],
  ['GET', /^\/api\/purchasing\/summary$/, (env, _m, _b, url) => purchasingSummary(env, url), 'read'],
  ['POST', /^\/api\/purchasing\/order$/, (env, m) => createOrdersFromSuggestions(env, m.request, m.user), 'move'],
  ['GET', /^\/api\/export\.procurement\.csv$/, (env, _m, _b, url) => exportProcureCsv(env, url), 'read'],

  /* --- cycle counting --- */
  ['GET', /^\/api\/counts$/, (env, _m, _b, url) => listCounts(env, url), 'read'],
  ['GET', /^\/api\/counts\/(\d+)$/, (env, m) => getCount(env, Number(m.params[0])), 'read'],
  ['POST', /^\/api\/counts$/, (env, m) => createCount(env, m.request, m.user), 'move'],
  ['PUT', /^\/api\/counts\/(\d+)$/, (env, m) => updateCount(env, Number(m.params[0]), m.request), 'move'],
  ['PATCH', /^\/api\/counts\/(\d+)$/, (env, m) => updateCount(env, Number(m.params[0]), m.request), 'move'],
  ['POST', /^\/api\/counts\/(\d+)\/post$/, (env, m) => postCount(env, Number(m.params[0]), m.request), 'move'],
  ['DELETE', /^\/api\/counts\/(\d+)$/, (env, m, _b, url) => deleteCount(env, Number(m.params[0]), url), 'manage'],
  ['GET', /^\/api\/export\.counts\.csv$/, (env, _m, _b, url) => exportCountCsv(env, url), 'read'],

  /* --- stock movement: operators and admins --- */
  ['POST', /^\/api\/movements$/, (env, m) => createMovement(env, m.request), 'move'],
  ['POST', /^\/api\/movements\/bulk$/, (env, m) => createBulkMovements(env, m.request), 'move'],
  ['DELETE', /^\/api\/movements\/(\d+)$/, (env, m) => deleteMovement(env, Number(m.params[0])), 'manage'],

  /* --- catalogue: admins only --- */
  ['POST', /^\/api\/products$/, (env, m) => createProduct(env, m.request), 'manage'],
  ['PUT', /^\/api\/products\/(\d+)$/, (env, m) => updateProduct(env, Number(m.params[0]), m.request), 'move'],
  ['PATCH', /^\/api\/products\/(\d+)$/, (env, m) => updateProduct(env, Number(m.params[0]), m.request), 'move'],
  ['DELETE', /^\/api\/products\/(\d+)$/, (env, m, _b, url) => deleteProduct(env, Number(m.params[0]), url), 'manage'],
  ['POST', /^\/api\/products\/(\d+)\/restore$/, (env, m) => restoreProduct(env, Number(m.params[0])), 'manage'],
]

/**
 * The decorated PDF report. Generating one is an auditable act — every
 * download is written to the credential/governance trail with the document id.
 */
async function downloadReport(env, request, url, user) {
  const response = await reportPdf(env, url, user)
  await recordEvent(env, request, user?.email ?? '', 'report_generated', `${response.headers.get('x-report-id')} (${url.searchParams.get('from') ?? 'default'} to ${url.searchParams.get('to') ?? 'today'})`).catch(() => {})
  return response
}

async function route(request, env, url) {
  if (url.pathname === '/api' || url.pathname === '/api/') {
    return json({
      service: 'Smart Inventory Management System',
      endpoints: ROUTES.map(([method, re]) => `${method} ${re.source.replace(/\\\//g, '/').replace(/^\^|\$$/g, '')}`),
    })
  }
  const method = request.method.toUpperCase()
  // One session lookup per request (skipped cheaply when no cookie is present).
  const user = await currentUser(env, request).catch(() => null)
  const allowed = []
  for (const [verb, pattern, handler, capability = 'read'] of ROUTES) {
    const match = pattern.exec(url.pathname)
    if (!match) continue
    if (verb !== method) {
      allowed.push(verb)
      continue
    }
    assertSameOrigin(request)
    if (capability !== 'public') {
      if (!user) {
        throw new HttpError(401, 'Sign in to continue', { cookie: COOKIE, login: '/api/auth/login' })
      }
      if (!can(user, capability)) {
        throw new HttpError(403, `Your role (${user.role}) cannot ${capability === 'read' ? 'view this' : 'perform this action'}`, { required: capability, role: user.role })
      }
    }
    return handler(env, { request, params: match.slice(1), url, user }, null, url)
  }
  if (allowed.length) {
    return json({ error: `Method ${method} not allowed` }, 405, { allow: allowed.join(', ') })
  }
  throw new HttpError(404, `No API route for ${method} ${url.pathname}`)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) {
      try {
        await bootstrap(env)
        return await route(request, env, url)
      } catch (err) {
        if (err instanceof HttpError) {
          return json({ error: err.message, details: err.details ?? null }, err.status, err.headers ?? {})
        }
        console.error('Unhandled API error', err && err.stack ? err.stack : err)
        return json({ error: 'Internal server error', message: String(err?.message ?? err) }, 500)
      }
    }

    // Static assets first; fall back to index.html so client routing works.
    const asset = await env.ASSETS.fetch(request)
    if (asset.status !== 404) return asset
    const spa = await env.ASSETS.fetch(new Request(new URL('/index.html', url), { headers: request.headers }))
    if (spa.status === 200) return new Response(spa.body, { status: 200, headers: spa.headers })
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  },
}
