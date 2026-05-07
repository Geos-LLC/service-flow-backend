'use strict';

// READ_ONLY_GUARD — wrap a Supabase-shaped client so any non-select op
// throws. Used by scripts/zb-cleanup-classify.js. Extracted into its own
// module so the guard semantics can be unit-tested without a live DB.
//
// The guard is belt-and-braces: the classifier itself only calls
// .select(...). The guard ensures that even a future change accidentally
// reaching for .insert/.update/.upsert/.delete/.rpc will throw at the
// boundary instead of silently mutating.

const FORBIDDEN_OPS = new Set([
  'insert',
  'update',
  'upsert',
  'delete',
  'rpc',
]);

function wrapBuilder(builder, table) {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && FORBIDDEN_OPS.has(prop)) {
        throw new Error(
          `[READ_ONLY_GUARD] refusing ${prop} on ${table} — read-only client`,
        );
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return (...args) => {
          const result = value.apply(target, args);
          // Re-wrap chainable builders. Real Supabase PostgrestBuilder is
          // thenable AND chainable, so we can't bail on `typeof .then`.
          // Bail only on actual Promises (which are returned by terminal
          // .then(resolve, reject) and shouldn't be re-wrapped).
          if (
            result &&
            typeof result === 'object' &&
            !(result instanceof Promise)
          ) {
            return wrapBuilder(result, table);
          }
          return result;
        };
      }
      return value;
    },
  });
}

function wrapClient(rawClient) {
  return new Proxy(rawClient, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table) => wrapBuilder(target.from(table), table);
      }
      if (prop === 'rpc') {
        return () => {
          throw new Error('[READ_ONLY_GUARD] rpc() not allowed');
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

module.exports = { wrapClient, wrapBuilder, FORBIDDEN_OPS };
