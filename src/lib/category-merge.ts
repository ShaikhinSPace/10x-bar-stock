// Folding one category into another.
//
// Kept out of db.ts (and so free of "server-only") purely so
// scripts/check-categories.mjs can run these exact statements against a real
// database. This is where the risk lives: a bottle carries ONE main category plus
// any number of tags, and the report's per-category totals are only correct while
// no bottle counts under two categories at once. A careless merge breaks that in
// two different ways at once, so the order below is load-bearing.

/**
 * Just enough of the neon tagged-template to type this file with no dependency on it.
 * Generic in the return so the driver's own query type passes straight through —
 * sql.transaction() needs its real NeonQueryPromise, not a plain Promise.
 */
type Sql<T> = (strings: TemplateStringsArray, ...vals: unknown[]) => T;

/**
 * The statements that fold `from` into `into`, in the order they must run.
 *
 * Returned rather than executed so the caller can hand them to sql.transaction()
 * and have the whole fold be all-or-nothing — half a merge would leave bottles
 * pointing at a category that no longer exists.
 *
 * 1. Drop `from` tags on bottles that already carry `into`. Without this, step 2
 *    would collide with the (item_id, cat) primary key.
 * 2. Retag the rest from -> into.
 * 3. Move the bottles whose MAIN category is `from`.
 * 4. Delete any tag that now equals its bottle's own main category. Step 3 creates
 *    exactly this case: a bottle tagged `into` whose main category just became
 *    `into`. Left alone it would be counted twice by every category total.
 * 5. Remove the now-empty category.
 */
export function mergeCategorySteps<T>(sql: Sql<T>, from: string, into: string): T[] {
  return [
    sql`delete from item_tags t
        where t.cat = ${from}
          and exists (select 1 from item_tags x
                      where x.item_id = t.item_id and x.cat = ${into})`,
    sql`update item_tags set cat = ${into} where cat = ${from}`,
    sql`update items set cat = ${into} where cat = ${from}`,
    sql`delete from item_tags t using items i where i.id = t.item_id and t.cat = i.cat`,
    sql`delete from categories where name = ${from}`,
  ];
}
