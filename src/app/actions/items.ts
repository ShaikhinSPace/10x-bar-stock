"use server";

import { refresh } from "next/cache";
import { sql, type Cat } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { attempt, whole, partial, knownCats, type Result } from "./_shared";

// Every export here is reachable by direct POST, so each one re-checks auth itself.

export async function addItem(
  name: string, cat: Cat, store: number, rl: number
): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    const n = name.trim();
    if (!n) throw new Error("Give the bottle a name");
    if (!(await knownCats()).has(String(cat))) throw new Error("Pick a category");

    const rows = await sql`
      insert into items (name, cat, store, rl)
      values (${n}, ${cat}, ${whole(store, "Opening stock")}, ${partial(rl, "Reorder level")})
      on conflict (name) do nothing returning id`;
    if (!rows.length) throw new Error(`"${n}" is already on the list.`);
    refresh();
  });
}

/**
 * Rename a bottle and set its categories.
 *
 * `cat` is the single main category - it drives every total, colour and the
 * beer cases rule - and `tags` are extra categories it can also be filtered
 * under, so a well whiskey counts once under Whiskey but still turns up under
 * Well. The main category is never duplicated into tags.
 *
 * Past moves keep the old name on purpose: item_name is denormalised into
 * `moves` precisely so the activity log stays readable after a rename.
 */
export async function editItem(
  itemId: number, name: string, cat: Cat, tags: Cat[]
): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    const n = name.trim();
    if (!n) throw new Error("Give the bottle a name");
    if (n.length > 80) throw new Error("That name is too long");
    const known = await knownCats();
    if (!known.has(String(cat))) throw new Error("Pick a main category");

    const extra = [...new Set((Array.isArray(tags) ? tags : []).filter((t) => known.has(String(t))))]
      .filter((t) => t !== cat);

    const renamed = await sql`
      update items set name = ${n}, cat = ${cat}
      where id = ${itemId} and not archived
        and not exists (select 1 from items o where o.name = ${n} and o.id <> ${itemId})
      returning id`;
    if (!renamed.length) {
      const [clash] = await sql`select id from items where name = ${n} and id <> ${itemId}`;
      throw new Error(clash ? `"${n}" is already on the list.` : "That bottle is no longer in the list.");
    }

    // Replace the tag set wholesale - simpler than diffing, and the table is
    // at most a handful of rows per item.
    await sql`delete from item_tags where item_id = ${itemId}`;
    if (extra.length) {
      await sql`
        insert into item_tags (item_id, cat)
        select ${itemId}, c from unnest(${extra}::text[]) as c`;
    }
    refresh();
  });
}

export async function setReorderLevel(itemId: number, rl: number): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    await sql`update items set rl = ${partial(rl, "Reorder level")} where id = ${itemId}`;
    refresh();
  });
}

/** Silences one item's reorder alert without touching its reorder level. */
export async function setReorderIgnore(itemId: number, ignore: boolean): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    await sql`update items set ignore_reorder = ${ignore} where id = ${itemId}`;
    refresh();
  });
}

export async function batchSetReorderLevels(updates: { id: number; rl: number }[]): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    if (!Array.isArray(updates) || !updates.length) throw new Error("No updates provided");
    for (const u of updates) {
      await sql`update items set rl = ${partial(u.rl, "Reorder level")} where id = ${u.id}`;
    }
    refresh();
  });
}

/** Archive, never delete — the activity log references the row. */
export async function archiveItem(itemId: number): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    await sql`update items set archived = true where id = ${itemId}`;
    refresh();
  });
}
