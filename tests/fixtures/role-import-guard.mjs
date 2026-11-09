// Module-load assertion in the real role server child, not a source-text check.
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    if (/\/managed\/|\/managed-tools\.js$|\/host-ipc\.js$/.test(specifier)) throw Error('old_execution_host_loaded');
    return next(specifier, context);
  },
});
