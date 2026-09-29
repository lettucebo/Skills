/**
 * Stub Pagefind module used by the search error-recovery tests.
 *
 * The real Pagefind bundle is only produced by `pagefind --site dist`, so the
 * tests point the component's base URL at this directory instead. Behaviour is
 * driven by `globalThis.__PAGEFIND_STUB__` so a single cached module can model
 * both the healthy and the failing search path.
 */
function stub() {
  globalThis.__PAGEFIND_STUB__ ??= {};
  return globalThis.__PAGEFIND_STUB__;
}

export async function options(received) {
  const state = stub();
  state.optionsCalls = (state.optionsCalls ?? 0) + 1;
  state.lastOptions = received;
  if (state.optionsFailures > 0) {
    state.optionsFailures -= 1;
    throw new Error('stubbed pagefind options failure');
  }
}

export async function search(query, received) {
  const state = stub();
  state.searchCalls = (state.searchCalls ?? 0) + 1;
  state.lastQuery = query;
  state.lastSearchOptions = received;
  if (state.searchThrows) throw new Error('stubbed pagefind search failure');
  if (state.searchPromise) return state.searchPromise;
  return { results: state.results ?? [] };
}

export async function preload(query, received) {
  const state = stub();
  state.preloadCalls = (state.preloadCalls ?? 0) + 1;
  state.lastPreloadQuery = query;
  state.lastPreloadOptions = received;
  if (state.preloadThrows) throw new Error('stubbed preload failure');
}

export async function destroy() {
  const state = stub();
  state.destroyCalls = (state.destroyCalls ?? 0) + 1;
}
