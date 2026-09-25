"use client";

import { useMemo, useState } from "react";
import { CAT_MAX, cap, fmt, fmtQty, normCat, type Cat, type Category, type Item, type SessionUser, type Staff } from "@/lib/model";
import { addItem, addUser, archiveItem, createCategory, deleteCategory, editItem, moveCategory, renameCategory, setReorderIgnore, setReorderLevel, setUserActive, type Result } from "../../actions";
import { useAction } from "../shell";
import { SortDir, catColor, rankIn, sortRows, useColumnSort, useEscapeClose, usePopoverClose } from "./shared";

type ManageSortKey = "name" | "cat" | "store" | "patio" | "back" | "rl";

export function Manage({
  items, staff, user, cats,
}: {
  items: Item[]; staff: Staff[]; user: SessionUser; cats: Category[];
}) {
  const catRank = useMemo(() => rankIn(cats), [cats]);
  const { pending, run } = useAction();
  const [name, setName] = useState("");
  const [cat, setCat] = useState<Cat>("WHISKEY");
  const [store, setStore] = useState("0");
  const [rl, setRl] = useState("2");
  const [mq, setMq] = useState("");

  const [uName, setUName] = useState("");
  const [uUser, setUUser] = useState("");
  const [uPass, setUPass] = useState("");
  const [uRole, setURole] = useState<"owner" | "staff">("staff");

  const [addStaffOpen, setAddStaffOpen] = useState(false);
  const addStaffRef = usePopoverClose(addStaffOpen, () => setAddStaffOpen(false));
  const [reportPeriod, setReportPeriod] = useState<"day" | "week" | "month">("week");
  const [allOpen, setAllOpen] = useState(false);

  const filtered = useMemo(() => {
    const out = [...items].sort((a, b) => catRank(a.cat) - catRank(b.cat) || a.name.localeCompare(b.name));
    const needle = mq.trim().toLowerCase();
    return needle ? out.filter((i) => i.name.toLowerCase().includes(needle)) : out;
  }, [items, mq, catRank]);

  const { sort: mSort, toggle: mToggle } = useColumnSort<ManageSortKey>();
  const shown = sortRows(filtered, mSort, (i, key) =>
    key === "name" ? i.name : key === "cat" ? i.cat
      : key === "store" ? i.store : key === "patio" ? i.patio
      : key === "back" ? i.back : i.rl);

  if (allOpen) return <AllBottlesView items={items} cats={cats} run={run} onClose={() => setAllOpen(false)} />;

  return (
    <>
      <div className="ptitle">Manage <span className="sub">bottles, reorder points &amp; staff</span></div>

      {/* Two columns on a wide screen: the three short panels stack down the
          left, the one long list takes the right. Falls back to a single
          stack below 900px, where the sidebar is gone anyway. */}
      <div className="mgrid">
        <div className="mg-col">

      <div className="card addcard">
        <div className="ch"><h3>Add a bottle</h3></div>
        <form className="frm" onSubmit={(e) => {
          e.preventDefault();
          if (pending) return;
          run(() => addItem(name, cat, Number(store), Number(rl)), `Added ${name.trim()}`);
        }}>
          <div className="fld">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Casamigos Mezcal" autoComplete="off" />
          </div>
          <div className="frow">
            <div className="fld">
              <label>Category</label>
              <select value={cat} onChange={(e) => setCat(e.target.value as Cat)}>
                {cats.map((c) => <option key={c.name} value={c.name}>{cap(c.name)}</option>)}
              </select>
            </div>
            <div className="fld">
              <label>In store</label>
              <input type="number" inputMode="numeric" min="0" value={store}
                onChange={(e) => setStore(e.target.value)} />
            </div>
            <div className="fld">
              <label>Reorder at</label>
              <input type="number" inputMode="numeric" min="0" value={rl}
                onChange={(e) => setRl(e.target.value)} />
            </div>
          </div>
          <button className="btn" type="submit" disabled={pending}>
            {pending ? "Adding…" : (
              <>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                </svg>
                Add bottle
              </>
            )}
          </button>
          <div className="hint">Opening stock is the storeroom count — bars get theirs from a Count.</div>
        </form>
      </div>

      <div className="card">
        <div className="ch">
          <h3>Staff</h3>
          <span className="badge">{staff.length}</span>
          <div className="popover-anchor mg-popover-trigger" ref={addStaffRef}>
            <button className="btn sm" onClick={() => setAddStaffOpen((o) => !o)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
              Add staff
            </button>
            {addStaffOpen && (
              <div className="popover">
                <button className="popover-close" aria-label="Close" onClick={() => setAddStaffOpen(false)}>×</button>
                <form className="frm" onSubmit={(e) => {
                  e.preventDefault();
                  if (pending) return;
                  run(() => addUser(uUser, uName, uPass, uRole), `Added ${uName.trim()}`);
                  setUPass("");
                }}>
                  <div className="frow">
                    <div className="fld">
                      <label>Name</label>
                      <input value={uName} onChange={(e) => setUName(e.target.value)} autoComplete="off" />
                    </div>
                    <div className="fld">
                      <label>Username</label>
                      <input value={uUser} onChange={(e) => setUUser(e.target.value)}
                        autoCapitalize="none" autoComplete="off" />
                    </div>
                  </div>
                  <div className="frow">
                    <div className="fld">
                      <label>Password</label>
                      <input type="password" value={uPass} onChange={(e) => setUPass(e.target.value)}
                        autoComplete="new-password" />
                    </div>
                    <div className="fld">
                      <label>Role</label>
                      <select value={uRole} onChange={(e) => setURole(e.target.value as "owner" | "staff")}>
                        <option value="staff">Staff</option>
                        <option value="owner">Owner</option>
                      </select>
                    </div>
                  </div>
                  <button className="btn" type="submit" disabled={pending}>
                    {pending ? "Adding…" : "Add person"}
                  </button>
                  <div className="hint">
                    Staff can give out, receive and count. Owners can also edit bottles and staff.
                  </div>
                </form>
              </div>
            )}
          </div>
        </div>

        {staff.map((s) => (
          <div className={`urow${s.active ? "" : " off"}`} key={s.id}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="t">{s.name}</div>
              <div className="s">@{s.username} · {s.role}{s.active ? "" : " · disabled"}</div>
            </div>
            {s.id !== user.id && (
              <button className="toggle"
                onClick={() => run(() => setUserActive(s.id, !s.active),
                  s.active ? `${s.name} disabled` : `${s.name} re-enabled`)}>
                {s.active ? "Disable" : "Enable"}
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <div className="ch">
          <h3>Reports</h3>
          <a className="btn sm" href={`/api/report?period=${reportPeriod}`} download>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" strokeLinecap="round" />
            </svg>
            Generate report
          </a>
        </div>
        <div className="chips" style={{ marginBottom: 10 }}>
          {([["day", "vs yesterday"], ["week", "vs last week"], ["month", "vs last month"]] as const)
            .map(([p, label]) => (
              <button key={p} className={`chip${reportPeriod === p ? " on" : ""}`}
                onClick={() => setReportPeriod(p)}>
                {label}
              </button>
            ))}
        </div>
        <div className="hint">
          A printable PDF: what you need to order, what moved, where counts disagreed with the
          system, wastage, deliveries and stock sitting untouched — each compared against the
          period before.
        </div>
      </div>

      <CategoriesCard cats={cats} run={run} pending={pending} />

        </div>

        <div className="mg-col">
      <div className="card">
        <div className="ch">
          <h3>All bottles</h3>
          <span className="badge">{items.length}</span>
          <button className="ch-open" onClick={() => setAllOpen(true)}>
            Open full list
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <BottleSearch value={mq} onChange={setMq} />
        <BottleSortChips sort={mSort} toggle={mToggle} />
        {!shown.length && <div className="empty" style={{ padding: 20 }}>No bottles match.</div>}
        {/* Capped so 136 bottles don't run the page on forever - the whole
            list lives behind "Open full list" in the header above. */}
        <div className="mlist">
        {shown.map((i) => <BottleRow key={i.id} i={i} cats={cats} run={run} />)}
        </div>
      </div>
        </div>
      </div>
    </>
  );
}

/** One editable bottle - shared by the Manage card and the full-list view. */
function BottleRow({ i, cats, run }: {
  i: Item;
  cats: Category[];
  run: (fn: () => Promise<Result>, ok: string, onOk?: () => void) => void;
}) {
  const { pending } = useAction();
  const [editing, setEditing] = useState(false);
  // Seeded fresh each time the form opens, so it always reflects the current row
  // and never carries a half-typed name from a previous edit.
  const [eName, setEName] = useState(i.name);
  const [eCat, setECat] = useState<Cat>(i.cat);
  const [eTags, setETags] = useState<Cat[]>(i.tags);

  function openEdit() {
    setEName(i.name); setECat(i.cat); setETags(i.tags); setEditing(true);
  }

  // The bottle's name and categories are edited here, in Manage, rather than on the
  // Stock tab's move sheet: renaming/recategorising is an owner setup task, not
  // something staff do mid-shift.
  if (editing) {
    return (
      <div className="mrow editing">
        <div className="medit">
          <div className="fld">
            <label>Name</label>
            <input value={eName} autoComplete="off" aria-label="Bottle name"
              onChange={(e) => setEName(e.target.value)} />
          </div>
          <div className="fld">
            <label>Main category</label>
            <select value={eCat} aria-label="Main category"
              onChange={(e) => setECat(e.target.value as Cat)}>
              {cats.map((c) => <option key={c.name} value={c.name}>{cap(c.name)}</option>)}
            </select>
          </div>
          <div>
            <div className="lbl">Also counts as</div>
            <div className="tagrow">
              {cats.map((x) => x.name).filter((c) => c !== eCat).map((c) => {
                const on = eTags.includes(c);
                return (
                  <button key={c} className={`tagchip${on ? " on" : ""}`} aria-pressed={on}
                    onClick={() => setETags((t) => (on ? t.filter((x) => x !== c) : [...t, c]))}>
                    {cap(c)}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="hint">
            The main category is what totals, colours and the beer cases rule use.
            Extra ones only make it findable there too — nothing is counted twice.
          </div>
          <div className="medit-foot">
            <button className="btn ghost" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn" disabled={pending || !eName.trim()}
              onClick={() => run(
                () => editItem(i.id, eName, eCat, eTags.filter((t) => t !== eCat)),
                `Saved ${eName.trim()}`,
                () => setEditing(false),
              )}>
              {pending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mrow">
      <div className="mn">
        <div className="t">{i.name}</div>
        <div className="s">
          {cap(i.cat)}
          {i.tags.length > 0 && ` + ${i.tags.map(cap).join(", ")}`}
          {" · "}store {fmtQty(i.cat, i.store)} · patio {fmtQty(i.cat, i.patio)} · back {fmtQty(i.cat, i.back)}
          {i.ignore_reorder && " · reorder alerts off"}
        </div>
      </div>
      <div className="rl">
        <label>reorder</label>
        <input type="number" inputMode="numeric" min="0" defaultValue={fmt(i.rl)}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (v !== i.rl) run(() => setReorderLevel(i.id, v), `${i.name} reorders at ${fmtQty(i.cat, v)}`);
          }} />
      </div>
      <button className={`rignore${i.ignore_reorder ? " on" : ""}`}
        aria-label={i.ignore_reorder
          ? `Turn reorder alerts back on for ${i.name}` : `Ignore reorder alerts for ${i.name}`}
        onClick={() => run(
          () => setReorderIgnore(i.id, !i.ignore_reorder),
          i.ignore_reorder ? `${i.name} reorder alerts back on` : `${i.name} won't raise reorder alerts anymore`,
        )}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2 2l20 20M6.7 6.7A6 6 0 0 0 6 10c0 4-2 5-2 5h11M14 17a2 2 0 0 1-3.46 1.37M11 5.06A6 6 0 0 1 18 11c0 1.7.34 2.9.75 3.75"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button className="medit-btn" aria-label={`Edit ${i.name}`} onClick={openEdit}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button className="del" aria-label={`Remove ${i.name}`} onClick={() => {
        if (confirm(`Remove "${i.name}" from the list? Its past activity stays in the log.`)) {
          run(() => archiveItem(i.id), "Bottle removed");
        }
      }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

function BottleSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="search" style={{ marginBottom: 12 }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" />
      </svg>
      <input placeholder="Search bottles…" value={value} autoComplete="off"
        onChange={(e) => onChange(e.target.value)} />
      {value && <button className="clr" aria-label="Clear search" onClick={() => onChange("")}>×</button>}
    </div>
  );
}

const MANAGE_SORTS = [
  ["name", "Name"], ["cat", "Category"], ["store", "Store"],
  ["patio", "Patio"], ["back", "Back"], ["rl", "Reorder"],
] as const;

function BottleSortChips({ sort, toggle }: {
  sort: { key: ManageSortKey; dir: SortDir } | null;
  toggle: (k: ManageSortKey) => void;
}) {
  return (
    <div className="chips" style={{ marginBottom: 12 }}>
      {MANAGE_SORTS.map(([key, label]) => (
        <button key={key} className={`chip${sort?.key === key ? " on" : ""}`} onClick={() => toggle(key)}>
          {label}{sort?.key === key && (sort.dir === 1 ? " ▲" : " ▼")}
        </button>
      ))}
    </div>
  );
}

/**
 * The whole bottle list, as its own view rather than a card the page has to
 * scroll past. Keeps its own search and sort so opening it always starts
 * from the full list, and mounts only while open so Escape closes it.
 */
/**
 * Create, rename, reorder, merge and delete categories.
 *
 * The order set here is the order categories appear in everywhere — the dashboard
 * chart, the Stock chips, both dropdowns, and the grouping every bottle list sorts by.
 *
 * Deleting is the one destructive path, so it asks where the bottles should go rather
 * than refusing or guessing. A category nothing points at deletes outright. Merging is
 * the same fold under a different name, which is why both routes end in one confirm.
 */
function CategoriesCard({
  cats, run, pending,
}: {
  cats: Category[];
  run: (fn: () => Promise<Result>, ok: string, onOk?: () => void) => void;
  pending: boolean;
}) {
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** The category whose "move its bottles where?" picker is open. */
  const [moving, setMoving] = useState<string | null>(null);
  const [into, setInto] = useState("");

  const others = cats.filter((c) => c.name !== moving);

  function add(e: React.FormEvent) {
    e.preventDefault();
    const name = normCat(adding);
    if (!name || pending) return;
    run(() => createCategory(name), `${name} added`, () => setAdding(""));
  }

  function saveName(from: string) {
    const to = normCat(draft);
    if (!to || to === from) { setEditing(null); return; }
    run(() => renameCategory(from, to), `${from} is now ${to}`, () => setEditing(null));
  }

  function remove(c: Category) {
    // refs, not items+tags: an archived bottle still holds the category's foreign key,
    // so it must be merged, not hard-deleted — matching what deleteCategory enforces.
    const inUse = c.refs > 0;
    if (!inUse) {
      if (!confirm(`Delete ${cap(c.name)}? Nothing is using it.`)) return;
      run(() => deleteCategory(c.name, null), `${cap(c.name)} deleted`);
      return;
    }
    // In use: open the picker instead of deleting, so the bottles get a home.
    setMoving(c.name);
    setInto(cats.find((x) => x.name !== c.name)?.name ?? "");
  }

  function confirmMove() {
    if (!moving || !into) return;
    const from = moving;
    const n = cats.find((c) => c.name === from);
    if (!confirm(
      `Move ${n?.items ?? 0} bottle(s) from ${cap(from)} into ${cap(into)} and delete ${cap(from)}?`
    )) return;
    run(() => deleteCategory(from, into), `${cap(from)} folded into ${cap(into)}`,
      () => setMoving(null));
  }

  return (
    <div className="card">
      <div className="ch">
        <h3>Categories</h3>
        <span className="badge">{cats.length}</span>
      </div>

      <form className="catadd" onSubmit={add}>
        <input value={adding} onChange={(e) => setAdding(e.target.value)}
          placeholder="New category…" maxLength={CAT_MAX} aria-label="New category name" />
        <button className="btn sm" disabled={pending || !normCat(adding)}>Add</button>
      </form>

      <div className="catlist">
        {cats.map((c, i) => (
          <div className="catrow" key={c.name}>
            <span className="cdot" style={{ background: catColor(c.name) }} />

            {editing === c.name ? (
              <input className="cedit" autoFocus value={draft} maxLength={CAT_MAX}
                aria-label={`Rename ${c.name}`}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => saveName(c.name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveName(c.name);
                  if (e.key === "Escape") setEditing(null);
                }} />
            ) : (
              <button className="cname" disabled={pending}
                onClick={() => { setEditing(c.name); setDraft(cap(c.name)); }}
                title="Rename">
                {cap(c.name)}
              </button>
            )}

            <span className="ccount">
              {c.items}{c.tags > 0 && <em> +{c.tags} tagged</em>}
            </span>

            <div className="cacts">
              <button className="cbtn" disabled={pending || i === 0} title="Move up"
                aria-label={`Move ${c.name} up`}
                onClick={() => run(() => moveCategory(c.name, -1), "Order saved")}>↑</button>
              <button className="cbtn" disabled={pending || i === cats.length - 1} title="Move down"
                aria-label={`Move ${c.name} down`}
                onClick={() => run(() => moveCategory(c.name, 1), "Order saved")}>↓</button>
              <button className="cbtn del" disabled={pending || cats.length <= 1} title="Delete"
                aria-label={`Delete ${c.name}`} onClick={() => remove(c)}>×</button>
            </div>
          </div>
        ))}
      </div>

      {moving && (
        <div className="catmove">
          <div className="lbl">Move everything in {cap(moving)} into</div>
          <div className="cmrow">
            <select value={into} onChange={(e) => setInto(e.target.value)}
              aria-label="Category to move into">
              {others.map((c) => <option key={c.name} value={c.name}>{cap(c.name)}</option>)}
            </select>
            <button className="btn sm" disabled={pending || !into} onClick={confirmMove}>
              Move &amp; delete
            </button>
            <button className="btn sm ghost" disabled={pending}
              onClick={() => setMoving(null)}>Cancel</button>
          </div>
          <div className="hint" style={{ margin: "6px 0 0" }}>
            Their tags come across too. A bottle that would end up counted twice keeps
            only its main category.
          </div>
        </div>
      )}

      <div className="hint">
        This order is the order categories appear in everywhere else. Tap a name to rename
        it — bottles follow automatically.
      </div>
    </div>
  );
}

function AllBottlesView({ items, cats, run, onClose }: {
  cats: Category[];
  items: Item[];
  run: (fn: () => Promise<Result>, ok: string, onOk?: () => void) => void;
  onClose: () => void;
}) {
  useEscapeClose(onClose);
  const catRank = useMemo(() => rankIn(cats), [cats]);
  const [q, setQ] = useState("");
  const { sort, toggle } = useColumnSort<ManageSortKey>();

  const filtered = useMemo(() => {
    const out = [...items].sort((a, b) => catRank(a.cat) - catRank(b.cat) || a.name.localeCompare(b.name));
    const needle = q.trim().toLowerCase();
    return needle ? out.filter((i) => i.name.toLowerCase().includes(needle)) : out;
  }, [items, q, catRank]);
  const shown = sortRows(filtered, sort, (i, key) =>
    key === "name" ? i.name : key === "cat" ? i.cat
      : key === "store" ? i.store : key === "patio" ? i.patio
      : key === "back" ? i.back : i.rl);

  return (
    <>
      <div className="stk-head">
        <div>
          <div className="ptitle" style={{ margin: 0 }}>
            All bottles <span className="sub">{shown.length} of {items.length}</span>
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            Set a reorder point, mute its alerts, or remove a bottle.
          </div>
        </div>
        <button className="btn ghost" onClick={onClose}>Done</button>
      </div>
      <BottleSearch value={q} onChange={setQ} />
      <BottleSortChips sort={sort} toggle={toggle} />
      {!shown.length && <div className="empty" style={{ padding: 20 }}>No bottles match.</div>}
      {shown.map((i) => <BottleRow key={i.id} i={i} cats={cats} run={run} />)}
    </>
  );
}
