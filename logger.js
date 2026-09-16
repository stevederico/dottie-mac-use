/**
 * Minimal structured logger — package-owned.
 * Gateway may inject its logger via setLogger() so in-process tool errors
 * still hit /system/errors.
 */

const ERROR_CATEGORIES = ['NETWORK', 'TOOL', 'LLM', 'SYSTEM'];
const MAX_ERRORS = 200;
const errorBuffer = [];

function timestamp() {
  const now = new Date();
  return `${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}`;
}

function formatLog(level, prefix, ...args) {
  const tag = prefix ? `[${prefix}]` : '';
  return `[${timestamp()}] [${level}] ${tag} ${args.join(' ')}`;
}

function recordError(prefix, message, err, context) {
  const category = (context?.category && ERROR_CATEGORIES.includes(context.category))
    ? context.category
    : 'SYSTEM';
  const ctxClean = context ? { ...context } : null;
  if (ctxClean) delete ctxClean.category;
  errorBuffer.push({
    timestamp: new Date().toISOString(),
    epoch: Date.now(),
    message,
    category,
    prefix,
    stack: err?.stack || null,
    context: (ctxClean && Object.keys(ctxClean).length > 0) ? ctxClean : null,
  });
  if (errorBuffer.length > MAX_ERRORS) errorBuffer.shift();
}

const localLog = {
  info: (prefix, ...args) => console.log(formatLog('INFO', prefix, ...args)),
  warn: (prefix, ...args) => console.warn(formatLog('WARN', prefix, ...args)),
  debug: (prefix, ...args) => {
    if (process.env.DEBUG_AGENT === 'true') console.log(formatLog('DEBUG', prefix, ...args));
  },
  error: (prefix, message, errOrCtx, context) => {
    let err = null;
    let ctx = context || null;
    if (errOrCtx instanceof Error) err = errOrCtx;
    else if (typeof errOrCtx === 'object' && errOrCtx !== null) ctx = errOrCtx;
    const parts = [message];
    if (err) parts.push(err.message);
    if (typeof errOrCtx === 'string') parts.push(errOrCtx);
    console.error(formatLog('ERROR', prefix, ...parts));
    recordError(prefix, parts.join(' '), err, ctx);
  },
};

function localGetRecentErrors(limit = 50) {
  return errorBuffer.slice(-limit).reverse();
}

/** @type {{ log: typeof localLog, getRecentErrors: typeof localGetRecentErrors }} */
let active = { log: localLog, getRecentErrors: localGetRecentErrors };

/** Inject gateway logger when running in-process under Dottie. */
export function setLogger(external) {
  if (!external?.log) throw new Error('setLogger requires { log, getRecentErrors? }');
  active = {
    log: external.log,
    getRecentErrors: external.getRecentErrors || localGetRecentErrors,
  };
}

export const log = {
  info: (...a) => active.log.info(...a),
  warn: (...a) => active.log.warn(...a),
  debug: (...a) => active.log.debug(...a),
  error: (...a) => active.log.error(...a),
};

export function getRecentErrors(limit = 50) {
  return active.getRecentErrors(limit);
}
