/**
 * Keep Dana's Astro lifecycle wiring testable without a browser or the live API.
 * The controller remains responsible for DOM behaviour; this adapter only decides
 * when the current server-rendered mount is bound, released, or disposed.
 *
 * @template T
 * @param {{
 *   findRoot: () => T | null,
 *   bind: (root: T) => void,
 *   unbind: () => void,
 *   dispose: () => void,
 * }} boundary
 */
export function createConciergeLifecycle(boundary) {
  /** @type {T | null} */
  let bound = null;

  function pageLoad() {
    const root = boundary.findRoot();
    if (!root) {
      if (bound) {
        boundary.unbind();
        bound = null;
      }
      return;
    }
    if (bound === root) return;
    if (bound) boundary.unbind();
    bound = root;
    boundary.bind(root);
  }

  function beforeSwap() {
    if (!bound) return;
    boundary.unbind();
    bound = null;
  }

  function pageHide() {
    boundary.dispose();
  }

  return Object.freeze({ pageLoad, beforeSwap, pageHide });
}
