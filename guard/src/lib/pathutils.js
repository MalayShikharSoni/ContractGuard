/** Wire-path helpers. Paths look like `premium.breakdown[].amount` or `holder.email`. */

/** Path of the parent node: 'a.b[].c' -> 'a.b[]', 'a[]' -> 'a', 'a' -> ''. */
export function parentPath(p) {
  if (!p) return '';
  const i = p.lastIndexOf('.');
  const j = p.lastIndexOf('[]');
  if (j > i) return p.slice(0, j);
  if (i > -1) return p.slice(0, i);
  return '';
}

/** Is `a` the same node as, or an ancestor container of, `b`? */
export function sameOrAncestor(a, b) {
  if (!a) return true;
  if (a === b) return true;
  return b.startsWith(`${a}.`) || b.startsWith(`${a}[]`);
}

/** Keep only the topmost paths: drop any path that has a proper ancestor in the set. */
export function pruneToTopmost(paths) {
  const list = [...paths];
  return list.filter((p) => !list.some((q) => q !== p && sameOrAncestor(q, p)));
}

/** First segment of a path (used for quick bucketing). */
export function rootOf(p) {
  const i = p.indexOf('.');
  const j = p.indexOf('[]');
  if (j > -1 && (i === -1 || j < i)) return p.slice(0, j);
  return i === -1 ? p : p.slice(0, i);
}
