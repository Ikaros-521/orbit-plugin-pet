/* cordis-lite pseudo-ctx — the slice of the Cordis plugin contract that
   self-contained DSH host-side plugins actually touch when running outside
   DeepSeek Harness:

     export const inject = ['someApi']
     export function apply(ctx) { ctx.get('someApi').foo(); ctx.effect(() => cleanup) }

   It gives those plugins a place to stand: a service registry (get/set),
   scoped disposal (effect/on), and nothing else. This mirrors how dsh-pet's
   own standalone mode hosts its host-half "on a pseudo ctx" (their words) —
   the route table stays the plugin's, only the transport is swapped.

   Deliberately NOT implemented: DSH's web-server mounting, model/session
   services, HMR, client-side same-page services. Plugins needing those are
   harness plugins, not companions, and stay out of scope. */

'use strict';

function createPseudoCtx() {
  const services = new Map(); // name -> value (ctx.set by the host)
  const disposers = [];       // return values of ctx.effect callbacks
  const listeners = new Map(); // event name -> Set<fn>

  const ctx = {
    /** Services this plugin wants before its apply() runs (Cordis `inject`). */
    inject: [],

    /** Resolve a service. Missing service -> null (caller decides if fatal). */
    get(name) { return services.get(name) || null; },

    /** Host-side: publish a service. Returns the ctx for chaining. */
    set(name, value) { services.set(name, value); return ctx; },

    /** Register scoped cleanup. The callback returns an un-register function,
        re-run when the ctx is disposed (plugin unload / disable). */
    effect(fn) {
      const off = typeof fn === 'function' ? fn() : null;
      disposers.push(off);
      return typeof off === 'function' ? off : () => {};
    },

    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => { listeners.get(event)?.delete(fn); };
    },

    emit(event, payload) {
      for (const fn of listeners.get(event) || []) {
        try { fn(payload); } catch (err) { console.warn(`[pseudo-ctx] listener for "${event}" threw:`, err.message); }
      }
    },

    /** Tear the whole scope down: run effect cleanups, drop listeners+services. */
    dispose() {
      while (disposers.length) {
        const off = disposers.pop();
        try { if (typeof off === 'function') off(); } catch { /* plugin's own problem */ }
      }
      listeners.clear();
      services.clear();
    },
  };
  return ctx;
}

/** Mount a Cordis-shaped plugin module ({ inject?, apply(ctx)? }) onto a
    pseudo-ctx. Fails loudly when an injected service is missing — a plugin
    that asked for a harness service should not silently half-run here.
    Returns a disposer that unmounts (runs the pseudo-ctx scope). */
function mountCordisPlugin(pctx, mod, label = 'plugin') {
  const wanted = Array.isArray(mod && mod.inject) ? mod.inject : [];
  const missing = wanted.filter(name => pctx.get(name) == null);
  if (missing.length) {
    throw new Error(`[${label}] injects unavailable service(s): ${missing.join(', ')} — this plugin needs DeepSeek Harness services this host does not provide`);
  }
  if (typeof (mod && mod.apply) === 'function') mod.apply(pctx);
  return () => pctx.dispose();
}

module.exports = { createPseudoCtx, mountCordisPlugin };
