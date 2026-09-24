"use server";

import { refresh } from "next/cache";
import { sql, CAT_MAX, normCat } from "@/lib/db";
import { mergeCategorySteps } from "@/lib/category-merge";
import { requireOwner } from "@/lib/auth";
import { attempt, type Result } from "./_shared";

// Every export here is reachable by direct POST, so each one re-checks auth itself.

/** Every category name currently in the database. Validation reads this, not a constant. */
async function catNames(): Promise<string[]> {
  const rows = await sql`select name from categories`;
  return rows.map((r) => r.name as string);
}

/** Shared checks for a name the owner typed. Returns the normalised form. */
function cleanCatName(raw: unknown): string {
  const name = normCat(String(raw ?? ""));
  if (!name) throw new Error("Give the category a name");
  if (name.length > CAT_MAX) throw new Error(`Keep it to ${CAT_MAX} characters or fewer`);
  if (!/^[A-Z0-9][A-Z0-9 &'-]*$/.test(name)) {
    throw new Error("Letters, numbers, spaces, & ' and - only");
  }
  return name;
}

export async function createCategory(raw: string): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    const name = cleanCatName(raw);

    // New categories go to the end of the list rather than jumping the order.
    const rows = await sql`
      insert into categories (name, sort)
      select ${name}, coalesce(max(sort), 0) + 1 from categories
      on conflict (name) do nothing
      returning name`;
    if (!rows.length) throw new Error(`${name} already exists`);
    refresh();
  });
}

export async function renameCategory(from: string, raw: string): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    const to = cleanCatName(raw);
    if (from === to) return;
    if (!(await catNames()).includes(from)) throw new Error("That category is already gone.");

    // items.cat and item_tags.cat both cascade, so this one statement carries the
    // new name out to every bottle and tag that referenced the old one.
    const rows = await sql`
      update categories set name = ${to}
      where name = ${from}
        and not exists (select 1 from categories where name = ${to})
      returning name`;
    if (!rows.length) throw new Error(`${to} already exists`);
    refresh();
  });
}

/**
 * Delete a category, moving anything that uses it somewhere else first.
 *
 * `into` is required whenever bottles or tags still point at the category — there is
 * no safe default, and silently dropping a bottle's category would break the foreign
 * key. An empty category deletes outright.
 */
export async function deleteCategory(name: string, into: string | null): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    const names = await catNames();
    if (!names.includes(name)) throw new Error("That category is already gone.");
    if (names.length <= 1) throw new Error("Every bottle needs a category — keep at least one.");

    const [used] = await sql`
      select (select count(*) from items     where cat = ${name} and not archived) as items,
             (select count(*) from item_tags where cat = ${name})                  as tags`;
    const inUse = Number(used.items) + Number(used.tags) > 0;

    if (!inUse) {
      await sql`delete from categories where name = ${name}`;
      refresh();
      return;
    }
    if (!into) throw new Error(`${name} is still in use — pick where its bottles should go`);
    if (into === name) throw new Error("Pick a different category to move them into");
    if (!names.includes(into)) throw new Error("That category is already gone.");

    await mergeCategory(name, into);
    refresh();
  });
}

/** Fold one category into another, moving its bottles and tags across. */
export async function mergeCategories(from: string, into: string): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    if (from === into) throw new Error("Pick two different categories");
    const names = await catNames();
    if (!names.includes(from) || !names.includes(into)) {
      throw new Error("One of those categories is already gone.");
    }
    await mergeCategory(from, into);
    refresh();
  });
}

/** The fold itself, all-or-nothing. See @/lib/category-merge for why the order matters.
 *  Callers must have validated both names first — this does no checking of its own. */
async function mergeCategory(from: string, into: string) {
  await sql.transaction(mergeCategorySteps(sql, from, into));
}

/** Move a category one place up or down the display order. */
export async function moveCategory(name: string, dir: -1 | 1): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    if (dir !== -1 && dir !== 1) throw new Error("Unknown direction");

    const rows = await sql`select name, sort from categories order by sort, name`;
    const at = rows.findIndex((r) => r.name === name);
    if (at < 0) throw new Error("That category is already gone.");
    const swap = at + dir;
    if (swap < 0 || swap >= rows.length) return; // already at the end; nothing to do

    // Sort values can be equal or null on rows that predate the column, so rewrite
    // the whole order from the array rather than swapping two numbers blind.
    const order = rows.map((r) => r.name as string);
    [order[at], order[swap]] = [order[swap], order[at]];
    await sql`
      update categories c set sort = o.ord
      from unnest(${order}::text[]) with ordinality as o(name, ord)
      where c.name = o.name`;
    refresh();
  });
}

/* ---------------- Manage (owner only) ---------------- */
