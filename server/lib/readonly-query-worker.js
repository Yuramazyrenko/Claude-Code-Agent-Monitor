/**
 * @file Executes backend-defined aggregate and event-page reads outside the HTTP thread using
 * a read-only connection. Opens no application DB module and runs no migrations.
 * Each connection closes before its result is delivered, including on errors.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const { parentPort, workerData } = require("node:worker_threads");
const scoped = require("./scoped-stats");

let Database;
try {
  if (workerData.driver === "compat") throw new Error("use compatibility driver");
  Database = require("better-sqlite3");
  new Database(":memory:").close();
} catch (error) {
  if (workerData.driver === "native") throw error;
  Database = require("../compat-sqlite");
}

function readQuery(db, query) {
  if (query.op === "eventPage") {
    const events = readQuery(db, {
      ...query.page,
      op: "all",
    });
    const { count: total } = readQuery(db, { ...query.count, op: "get" });
    return { events, total };
  }
  if (query.op === "get" || query.op === "all") {
    if (typeof query.sql !== "string" || !/^\s*SELECT\b/i.test(query.sql))
      throw new Error("Only SELECT reads are supported");
    const statement = db.prepare(query.sql);
    return query.op === "get"
      ? statement.get(...(query.params || []))
      : statement.all(...(query.params || []));
  }
  if (query.op !== "stats") throw new Error("Unsupported database read");
  const { sources, providers, toLocal, toUTC } = query;
  const isScoped = !!sources || !!providers;
  // One read transaction keeps overview, status distributions and today's
  // count on the same snapshot even while the HTTP thread accepts new hooks.
  const overview = isScoped
    ? scoped.statsOverview(db, sources, providers)
    : db.prepare(scoped.GLOBAL_STATS_SQL).get();
  const agents = isScoped
    ? scoped.agentStatusCounts(db, sources, providers)
    : db.prepare("SELECT status, COUNT(*) as count FROM agents GROUP BY status").all();
  const sessions = isScoped
    ? scoped.sessionStatusCounts(db, sources, providers)
    : db.prepare("SELECT status, COUNT(*) as count FROM sessions GROUP BY status").all();
  const today = isScoped
    ? scoped.countEventsToday(db, sources, providers, toLocal, toUTC)
    : db
        .prepare(
          "SELECT COUNT(*) as count FROM events WHERE created_at >= datetime('now', ?, 'start of day', ?)"
        )
        .get(toLocal, toUTC);
  return {
    ...overview,
    events_today: today?.count ?? 0,
    agents_by_status: Object.fromEntries(agents.map((row) => [row.status, row.count])),
    sessions_by_status: Object.fromEntries(sessions.map((row) => [row.status, row.count])),
  };
}

parentPort.on("message", ({ id, query }) => {
  let db;
  let result;
  let error;
  try {
    db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    db.pragma("busy_timeout = 1000");
    db.exec("BEGIN");
    // Pin the WAL read snapshot before reporting start; a concurrent writer
    // cannot change this read's generation halfway through its aggregates.
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
    parentPort.postMessage({ id, started: true });
    result = readQuery(db, query);
    db.exec("COMMIT");
  } catch (caught) {
    error = caught.message || String(caught);
  } finally {
    if (db) {
      try {
        db.close();
      } catch (caught) {
        error = error || caught.message;
      }
    }
  }
  parentPort.postMessage({ id, result, error });
});
