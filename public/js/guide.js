/*
 * Guidance on entry screens. While an entry is being made it says what is missing (stock,
 * chemicals, packing, master records), where the stock is instead, which step brings it (a button,
 * or who to ask when this login cannot do that step) and what comes next. Shown as a panel above
 * the form, plus a note under any line that is short of stock.
 */
'use strict';

const Guide = (() => {
  // [button text, who does it, screen path] for each step a note can point to.
  const STEPS = {
    purchaseOrders: ['New purchase order', 'the Purchase department'],
    grn: ['New GRN', 'the Store'],
    yarnIssue: ['Issue yarn', 'the Store'],
    transfers: ['New stock transfer', 'the Store'],
    greyTransfer: ['Send grey for dyeing', 'the Knitting department'],
    godownTransfer: ['New godown transfer', 'the Godown / Store'],
    knitting: ['New knitting entry', 'the Knitting department'],
    dyeing: ['New dyeing entry', 'the Dyeing department'],
    finishing: ['New finishing entry', 'the Finishing department'],
    items: ['Add item', 'the administrator (Masters)'],
    parties: ['Add supplier', 'the administrator (Masters)'],
    customers: ['Add customer', 'the Sales department'],
    processes: ['Standard rates', 'the administrator (Masters)', '#/list/processes'],
    boms: ['Add recipe', 'the administrator (Masters)'],
  };
  const step = key => {
    const s = STEPS[key];
    if (!s) return null;
    return SCHEMAS[key] && Perm.can(SCHEMAS[key].area, 'edit') ? { label: s[0], href: s[2] || '#/edit/' + key + '/new' } : { ask: s[1] };
  };
  const editItem = it => Perm.can('masters', 'edit') ? { label: 'Edit ' + nm(it), href: '#/edit/items/' + it.id } : { ask: 'the administrator (Masters)' };
  const note = (level, text, action) => ({ level, text, action: typeof action === 'string' ? step(action) : action || null });

  /* ---- stock helpers (ctx.stockRows: what is in stock now, per item / location / lot) ---- */
  const locNames = () => Object.fromEntries(Cache.list('locations').map(l => [l.id, l.name]));
  const locName = id => locNames()[id] || id;
  const amt = (q, item) => U.qty(q) + (unitOf(item) ? ' ' + unitOf(item) : '');
  const rows = ctx => ctx.stockRows ? ctx.stockRows() : [];
  const catOf = id => (itemOf(id) || {}).category || '';
  const nm = it => String((it && it.name) || '').trim();
  const qtyAt = (ctx, item, loc) => rows(ctx).filter(r => r.item === item && r.loc === loc && r.qty > 0).reduce((t, r) => t + r.qty, 0);
  const haveAt = (ctx, test) => { const m = {}; for (const r of rows(ctx)) if (r.qty > 0.0005 && test(r)) m[r.loc] = (m[r.loc] || 0) + r.qty; return m; };
  // Items of these categories in stock at a location: [{ item, qty, lots }], biggest first.
  function stockOf(ctx, cats, loc) {
    const m = new Map();
    for (const r of rows(ctx)) {
      if (r.loc !== loc || !(r.qty > 0.0005) || !cats.includes(catOf(r.item))) continue;
      const e = m.get(r.item) || { item: r.item, qty: 0, lots: [] };
      e.qty += r.qty; if (r.lot) e.lots.push(r.lot); m.set(r.item, e);
    }
    return [...m.values()].sort((a, b) => b.qty - a.qty);
  }
  const more = (n, max) => n > max ? ' and ' + (n - max) + ' more' : '';
  const listOf = (list, max = 4) => list.slice(0, max).map(e => nm(itemOf(e.item)) + ' ' + amt(e.qty, e.item) +
    (e.lots.length > 1 ? ' in ' + e.lots.length + ' lots' : e.lots.length ? ' (lot ' + e.lots[0] + ')' : '')).join(', ') + more(list.length, max);
  function lotsWaiting(ctx, cats, loc, max = 5) {
    const l = rows(ctx).filter(r => r.loc === loc && r.qty > 0.0005 && cats.includes(catOf(r.item))).sort((a, b) => (a.lot || '').localeCompare(b.lot || ''));
    return l.slice(0, max).map(r => (r.lot || 'no lot') + ' ' + amt(r.qty, r.item)).join(', ') + more(l.length, max);
  }
  const hasItems = cat => Cache.list('items').some(i => i.category === cat);
  const catSupply = (ctx, cat, loc) => S.supplyHint(cat, loc, haveAt(ctx, r => catOf(r.item) === cat), locNames(), cat === 'Packing Material' ? '' : 'kg');
  // Raw material missing from the Main Store: if it is already on order, the step is to receive it.
  function storeSupply(ctx, cat) {
    const open = Cache.list('purchaseOrders').filter(po => po.status !== 'Cancelled' && pendingFrom(po, 'grn', 'poId').some(l => catOf(l.item) === cat));
    if (!open.length) return catSupply(ctx, cat, 'STORE');
    return { text: (open.length === 1 ? 'Purchase order ' + open[0].no + ' is' : open.length + ' purchase orders (' + nos(open) + ') are') + ' still to be received: when the goods arrive, make the GRN against it.', screen: 'grn' };
  }
  // Where material of these categories is now, place by place: "Agency A (L-0001 500 kg); Agency B (...)".
  function whereIs(ctx, cats, test, max = 4) {
    const m = new Map();
    for (const r of rows(ctx)) {
      if (!(r.qty > 0.0005) || !test(r.loc) || !cats.includes(catOf(r.item))) continue;
      const e = m.get(r.loc) || []; e.push((r.lot || 'no lot') + ' ' + amt(r.qty, r.item)); m.set(r.loc, e);
    }
    const list = [...m.entries()];
    return list.slice(0, max).map(([l, lots]) => locName(l) + ' (' + lots.slice(0, 3).join(', ') + more(lots.length, 3) + ')').join('; ') + more(list.length, max);
  }
  const godown = id => S.isGodown(Cache.byId('locations', id));
  const godownName = id => locName(id || 'FG');
  const atAgency = l => l !== 'STORE' && !godown(l);

  /* ---- agencies (parties that knit, dye or finish for us) ---- */
  const WORD = { Knitting: 'knitting', Dyeing: 'dyeing', Finishing: 'finishing' };
  const places = stage => Cache.list('locations').filter(l => S.doesWork(l, stage, id => Cache.byId('parties', id)));
  const masters = (label, href) => Perm.can('masters', 'edit') ? { label, href } : { ask: 'the administrator (Masters)' };
  const noAgency = stage => !places(stage).length && note('stop', 'No ' + WORD[stage] + ' agency yet. Add it in Masters → Parties: type Job Worker, tick "Does ' + WORD[stage] + '" and give its rate per kg.', masters('Add agency', '#/edit/parties/new'));
  function noRate(d, stage) {
    if (S.num(d.labourRate) || S.num(d.labour)) return null;
    const l = Cache.byId('locations', d.location), p = l && l.party ? Cache.byId('parties', l.party) : null;
    return note('warn', 'There is no ' + WORD[stage] + ' rate, so the job charges will be ₹0 and the lot will look cheaper than it is. ' +
      (p ? 'Set the rate of ' + nm(p) + ' in Masters → Parties' : 'Set the rate in Masters → Processes') + ', or type the charges.', p ? masters('Edit ' + nm(p), '#/edit/parties/' + p.id) : 'processes');
  }

  const suppliers = () => Cache.list('parties').some(p => S.partyIs(p, 'Supplier'));
  const customers = () => Cache.list('parties').some(p => S.partyIs(p, 'Customer'));
  const nos = list => list.slice(0, 3).map(d => d.no).join(', ') + more(list.length, 3);

  // Note under a line that takes stock from a location: nothing there, not enough, or no lot chosen.
  function lineHint(s, col, row, doc, ctx) {
    if (!row.item || (s.col === 'invoices' && doc.challanId)) return null;
    if (col.signed && S.num(row.qty) >= 0) return null; // a + adjustment line brings stock in
    const loc = col.loc(doc, row);
    if (!loc) return null;
    const it = itemOf(row.item) || {};
    const need = Math.abs(S.num(row.qty));
    const inLoc = qtyAt(ctx, row.item, loc);
    const here = locName(loc);
    const supply = () => S.supplyHint(it.category, loc, haveAt(ctx, r => r.item === row.item), locNames(), unitOf(row.item));
    if (inLoc <= 0.0005) { const h = supply(); return { text: 'No ' + nm(it) + ' at ' + here + '. ' + h.text, screen: h.screen, item: nm(it) }; }
    const named = ctx.lots(loc, row.item).filter(x => x.lot && x.qty > 0.0005);
    const inLot = ctx.available(loc, row.item, row.lot);
    if (!row.lot && named.length && inLot <= 0.0005) return { text: 'Choose the lot to take it from: ' + here + ' has ' + amt(inLoc, row.item) + ' in ' + named.length + ' lot' + (named.length === 1 ? '' : 's') + '.' };
    if (need > inLoc + 0.0005) {
      const h = supply();
      return { text: 'Needs ' + amt(need, row.item) + ' but ' + here + ' has only ' + amt(inLoc, row.item) + ' (short ' + amt(need - inLoc, row.item) + '). ' + h.text, screen: h.screen, item: nm(it) };
    }
    if (need > inLot + 0.0005) return { text: (row.lot ? 'Lot ' + row.lot : 'Stock without a lot') + ' has only ' + amt(inLot, row.item) + ' here. Take the rest from another lot on a new line (' + amt(inLoc, row.item) + ' in all).' };
    return null;
  }
  // One line in the panel summing up the lines that are short.
  function shortNote(s, doc, ctx) {
    const hits = [];
    for (const g of s.grids) {
      const col = g.cols.find(c => c.type === 'lot');
      if (col) for (const r of doc[g.k] || []) { const x = lineHint(s, col, r, doc, ctx); if (x && x.screen) hits.push(x); }
    }
    if (!hits.length) return null;
    return note('warn', 'Not enough in stock for ' + [...new Set(hits.map(x => x.item))].join(', ') + '. See the note under ' + (hits.length === 1 ? 'that line' : 'those lines') + '.', hits[0].screen);
  }

  const noSuppliers = () => !suppliers() && note('stop', 'No suppliers yet. Add the supplier in Masters → Parties (type Supplier) first.', 'parties');
  const noCustomers = () => !customers() && note('stop', 'No customers yet. Add the customer in Customers → Customer Master first.', 'customers');
  const noItem = cat => !hasItems(cat) && note('stop', 'There is no ' + cat + ' item yet. Add one in Masters → Items with category ' + cat + '.', 'items');

  function saleNotes(d, ctx, col) {
    const out = [noCustomers()];
    const loc = d.location || 'FG';
    if (!stockOf(ctx, ['Finished Goods'], loc).length) {
      const h = catSupply(ctx, 'Finished Goods', loc);
      out.push(note('stop', 'No finished goods in ' + godownName(loc) + ' to dispatch. ' + h.text, h.screen));
    }
    if (d.party && col === 'deliveries' && !d.soId) {
      const open = Cache.list('salesOrders').filter(o => o.party === d.party && o.status === 'Open' && pendingFrom(o, 'deliveries', 'soId', d.id).length);
      if (open.length) out.push(note('tip', (open.length === 1 ? 'Sales order ' + open[0].no + ' from this customer is' : open.length + ' sales orders from this customer (' + nos(open) + ') are') + ' still to be dispatched: choose it in "Against sales order" to load what is pending.'));
    }
    if (d.party && col === 'invoices') {
      const open = Cache.list('deliveries').filter(c => c.party === d.party && !Cache.list('invoices').some(i => i.challanId === c.id && i.id !== d.id));
      if (open.length) out.push(note('warn', (open.length === 1 ? 'Challan ' + open[0].no + ' to this customer is' : open.length + ' challans to this customer (' + nos(open) + ') are') + ' not invoiced yet. Choose it in "Against challan": its goods have already left, so a direct invoice would take the stock a second time.'));
    }
    return out;
  }

  const RULES = {
    purchaseOrders: () => [noSuppliers()],
    grn: d => {
      const out = [noSuppliers()];
      if (d.party && !d.poId) {
        const open = Cache.list('purchaseOrders').filter(po => po.party === d.party && po.status !== 'Cancelled' && pendingFrom(po, 'grn', 'poId', d.id).length);
        if (open.length) out.push(note('tip', (open.length === 1 ? 'Purchase order ' + open[0].no + ' from this supplier is' : open.length + ' purchase orders from this supplier (' + nos(open) + ') are') + ' still to be received: choose it in "Against PO" to load the pending quantities.'));
      }
      const seen = new Set();
      for (const l of d.lines || []) {
        const it = itemOf(l.item);
        if (!it || seen.has(it.id)) continue;
        seen.add(it.id);
        if (['Finished Goods', 'Colored Fabric', 'Grey Fabric'].includes(it.category) && d.location === 'STORE') {
          out.push(note('warn', nm(it) + ' is a ' + it.category + ' item, but it is being received at the Main Store. Knitting uses only Yarn items, and sales take stock only from the Finished Goods Store. If it is for sale, set "Received at" to Finished Goods Store. If it is really yarn, change its category to Yarn first.', editItem(it)));
        } else if (S.RAW_CATEGORIES.includes(it.category) && d.location && d.location !== 'STORE') {
          out.push(note('warn', nm(it) + ' (' + it.category + ') is being received at ' + locName(d.location) + '. Yarn issues, dyeing and packing take material from the Main Store, so receive it there unless that is what you mean.'));
        }
      }
      return out;
    },
    purchaseBills: d => {
      const out = [noSuppliers()];
      if (d.party && !d.grnId) {
        const open = Cache.list('grn').filter(g => g.party === d.party && !Cache.list('purchaseBills').some(b => b.grnId === g.id && b.id !== d.id));
        out.push(open.length
          ? note('tip', 'Not billed yet from this supplier: ' + nos(open) + '. Choose the GRN in "Against GRN" to copy its lines and rates.')
          : note('warn', 'Every GRN from ' + partyName(d.party) + ' is already billed. A bill normally follows a GRN: check the supplier, or ask the Store whether the goods have been received.', 'grn'));
      }
      return out;
    },
    yarnIssue: (d, ctx) => {
      if (!hasItems('Yarn')) return [noItem('Yarn')];
      const out = [noAgency('Knitting')];
      const yarn = stockOf(ctx, ['Yarn'], 'STORE');
      if (!yarn.length) { const h = storeSupply(ctx, 'Yarn'); out.push(note('stop', 'No yarn in the Main Store to issue. ' + h.text, h.screen)); }
      else if (!(d.lines || []).some(l => l.item)) out.push(note('tip', 'Yarn in the Main Store: ' + listOf(yarn) + '.'));
      for (const e of stockOf(ctx, ['Grey Fabric', 'Colored Fabric', 'Finished Goods'], 'STORE')) {
        const it = itemOf(e.item);
        out.push(note('warn', nm(it) + ' (' + amt(e.qty, e.item) + ') is in the Main Store, but its category is ' + it.category + ', so it cannot be issued to knitting. If it is yarn, change its category to Yarn. If it is for sale, move it to the Finished Goods Store with a stock transfer.', editItem(it)));
      }
      return out;
    },
    greyTransfer: (d, ctx) => {
      const out = [noAgency('Dyeing')];
      if (!d.fromLoc) {
        const w = whereIs(ctx, ['Grey Fabric'], l => !godown(l));
        out.push(note('tip', w ? 'Grey fabric now at: ' + w + '.' : 'There is no grey fabric anywhere yet: knit a lot first.'));
      } else if (!stockOf(ctx, ['Grey Fabric'], d.fromLoc).length) {
        out.push(note('tip', 'Nothing is waiting at ' + locName(d.fromLoc) + '. Knitting entries normally send the grey fabric straight to the dyeing agency, so this screen is only for fabric that was kept back.'));
      }
      return out;
    },
    knitting: (d, ctx) => {
      const out = [noItem('Grey Fabric'), noAgency('Knitting')];
      if (!d.location) {
        const w = whereIs(ctx, ['Yarn'], atAgency);
        if (w) out.push(note('tip', 'Choose the knitting agency. Yarn issued to agencies: ' + w + '.'));
      } else {
        const yarn = stockOf(ctx, ['Yarn'], d.location);
        if (!yarn.length) { const h = catSupply(ctx, 'Yarn', d.location); out.push(note('stop', 'No yarn at ' + locName(d.location) + '. ' + h.text, h.screen)); }
        else if (!(d.lines || []).some(l => l.item)) out.push(note('tip', 'Yarn at ' + locName(d.location) + ': ' + listOf(yarn) + '.'));
      }
      out.push(noRate(d, 'Knitting'));
      return out;
    },
    dyeing: (d, ctx) => {
      const out = [noItem('Colored Fabric'), noAgency('Dyeing')];
      if (!d.location) {
        const w = whereIs(ctx, ['Grey Fabric'], atAgency);
        if (w) out.push(note('tip', 'Choose the dyeing agency. Grey fabric at the agencies: ' + w + '.'));
      } else if (!stockOf(ctx, ['Grey Fabric'], d.location).length) {
        const h = catSupply(ctx, 'Grey Fabric', d.location);
        out.push(note('stop', 'No grey fabric waiting at ' + locName(d.location) + '. ' + h.text, h.screen));
      } else if (!d.lotNo) out.push(note('tip', 'Grey lots waiting at ' + locName(d.location) + ': ' + lotsWaiting(ctx, ['Grey Fabric'], d.location) + '.'));
      if (stockOf(ctx, ['Dyes & Chemicals'], 'STORE').length && !Cache.list('boms').some(b => b.stage === 'Dyeing')) out.push(note('tip', 'If you supply the dyes and chemicals, save your recipes in Masters → BOM / Recipes: picking one fills the chemicals for the batch weight.', 'boms'));
      out.push(noRate(d, 'Dyeing'));
      return out;
    },
    finishing: (d, ctx) => {
      const out = [noItem('Finished Goods'), noAgency('Finishing')];
      if (!d.location) {
        const w = whereIs(ctx, ['Colored Fabric'], atAgency);
        if (w) out.push(note('tip', 'Choose the finishing agency. Dyed fabric at the agencies: ' + w + '.'));
      } else if (!stockOf(ctx, ['Colored Fabric'], d.location).length) {
        const grey = stockOf(ctx, ['Grey Fabric'], d.location).length;
        const h = grey ? { text: 'Its grey lots must be dyed first.', screen: 'dyeing' } : catSupply(ctx, 'Colored Fabric', d.location);
        out.push(note('stop', 'No dyed fabric waiting at ' + locName(d.location) + '. ' + h.text, h.screen));
      } else if (!d.lotNo) out.push(note('tip', 'Dyed lots ready at ' + locName(d.location) + ': ' + lotsWaiting(ctx, ['Colored Fabric'], d.location) + '.'));
      if ((Cache.settings || {}).weighRolls && S.num(d.outQty) > 0 && !String(d.rollWeights || '').trim()) out.push(note('tip', 'Weigh each roll and type the weights in "Roll weights" (for example 20.2 + 50.3 + 39.5). Sales then go roll by roll and the stock shows every roll.'));
      out.push(noRate(d, 'Finishing'));
      return out;
    },
    salesOrders: (d, ctx) => {
      const out = [noCustomers()];
      for (const l of d.lines || []) {
        if (!l.item || !(S.num(l.qty) > 0)) continue;
        const have = rows(ctx).filter(r => r.item === l.item && godown(r.loc) && r.qty > 0).reduce((t, r) => t + r.qty, 0), it = itemOf(l.item) || {};
        if (S.num(l.qty) > have + 0.0005) out.push(note('tip', nm(it) + ': ordered ' + amt(l.qty, l.item) + ', the godowns have ' + (have > 0.0005 ? 'only ' + amt(have, l.item) + ', so ' + amt(S.num(l.qty) - have, l.item) + ' must' : 'none, so it must') + ' be produced before dispatch.'));
      }
      return out;
    },
    godownTransfer: (d, ctx) => {
      const out = [];
      if (Cache.list('locations').filter(l => S.isGodown(l) && !l.inactive).length < 2) out.push(note('stop', 'There is only one godown. Add the others in Masters → Locations & Godowns with type Godown.', masters('Add godown', '#/edit/locations/new')));
      else if (d.fromLoc && !stockOf(ctx, ['Finished Goods'], d.fromLoc).length) out.push(note('tip', 'No finished goods in ' + godownName(d.fromLoc) + '. Godowns with stock: ' + (whereIs(ctx, ['Finished Goods'], godown) || 'none') + '.'));
      return out;
    },
    jobStatus: (d, ctx) => {
      const w = whereIs(ctx, ['Grey Fabric', 'Colored Fabric'], atAgency);
      if (!w) return [note('tip', 'No grey or dyed fabric is at an agency right now.')];
      return [d.location && !rows(ctx).some(r => r.loc === d.location && r.qty > 0.0005 && ['Grey Fabric', 'Colored Fabric'].includes(catOf(r.item)))
        ? note('warn', 'No grey or dyed fabric at ' + locName(d.location) + '. Fabric at the agencies: ' + w + '.') : !d.location ? note('tip', 'Fabric at the agencies: ' + w + '.') : null];
    },
    leads: d => d.status === 'Won' && !d.party
      ? [note('tip', 'Won: add ' + (d.name || 'them') + ' as a customer, then choose them here under "Existing customer".', Perm.can('masters', 'edit')
        ? { label: 'Add customer', href: '#/edit/customers/new?' + new URLSearchParams({ name: d.name || '', phone: d.phone || '', city: d.city || '', contactPerson: d.contactPerson || '' }).toString() } : 'customers')]
      : [],
    deliveries: (d, ctx) => saleNotes(d, ctx, 'deliveries'),
    invoices: (d, ctx) => d.challanId ? [] : saleNotes(d, ctx, 'invoices'),
  };

  // What happens after this entry is saved.
  const NEXT = {
    purchaseOrders: 'Next: when the goods arrive, the Store makes a GRN against this order.',
    grn: 'Next: Purchase books the supplier bill against this GRN, and the Store issues the yarn to a knitting agency by its lot number (Yarn Issue to Knitting).',
    purchaseBills: 'Next: Accounts pays the supplier (Supplier Payments).',
    yarnIssue: 'Next: when the agency delivers the grey fabric, the Knitting department makes the knitting entry for that agency; the fabric keeps the same lot number.',
    greyTransfer: 'Next: when the dyeing agency delivers, the Dyeing department picks the lot from that agency\'s lot list.',
    knitting: 'Next: the grey fabric is at the agency it was sent to, under the same lot number. When it is dyed, the Dyeing department picks it from that agency\'s lot list.',
    dyeing: 'Next: when the finished rolls come back, Finishing & Packing picks this colored lot from the lot list of the agency it was sent to.',
    finishing: 'Next: Sales dispatches it from the godown with a challan or invoice; a Godown Transfer moves rolls to another godown first if needed.',
    leads: 'Next: send a quotation (Sales → Quotations, "For lead"), and note each follow-up here.',
    quotations: 'Next: when the customer confirms, make the sales order and choose this quotation under "Against quotation".',
    salesOrders: 'Next: a delivery challan against this order loads the pending quantity.',
    deliveries: 'Next: make the invoice against this challan.',
    invoices: 'Next: record the payment in Customer Receipts when it arrives.',
  };
  // Lists the rules above read, loaded with the form.
  const NEEDS = {
    grn: ['purchaseOrders'], purchaseBills: ['grn', 'purchaseBills'], deliveries: ['salesOrders', 'invoices'], invoices: ['deliveries', 'invoices'],
    yarnIssue: ['purchaseOrders', 'grn'], dyeing: ['purchaseOrders', 'grn'], finishing: ['purchaseOrders', 'grn'], leads: ['parties'],
  };

  function panel(s, doc, ctx) {
    const rule = RULES[s.key];
    const notes = (rule ? rule(doc, ctx) : []).filter(Boolean);
    const sn = shortNote(s, doc, ctx);
    if (sn) notes.push(sn);
    const rank = { stop: 0, warn: 1, tip: 2 };
    notes.sort((a, b) => rank[a.level] - rank[b.level]);
    return { notes, next: ctx.isNew ? NEXT[s.key] || '' : '' };
  }

  return { panel, lineHint, needs: key => NEEDS[key] || [], usesStock: key => key in RULES };
})();
