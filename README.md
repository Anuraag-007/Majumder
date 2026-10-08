# Majumdaar Hosiery ERP

A web-based ERP for a hosiery unit. It covers the full flow:

**Raw material purchase → knitting → coloring → finishing & packing → finished goods → sales → customer**,
with wastage tracking and exact costing at every stage.

Built with Node.js + plain HTML, CSS and JavaScript. It has **no npm dependencies**, so there is nothing to `npm install`.

## Run it

1. Install **Node.js LTS** from https://nodejs.org (version 22.13 or newer; the ERP uses the SQLite database built into Node).
2. Double-click `start.bat`, or open a terminal in this folder and run:
   ```
   node server.js
   ```
3. Open http://localhost:3000 and sign in with **admin / admin123**. Change the password under *User Management → Settings & Backup*.

To try the app with sample data, click *Settings & Backup → Load demo data* on an empty database, or run `node server/seed.js --demo`.

Other computers on the same network can use it at `http://<this-pc-ip>:3000`.

To put it on the internet (Hostinger VPS, HTTPS, nightly backups), follow **[DEPLOY.md](DEPLOY.md)**. Set a different port with the `PORT` environment variable.

## Modules

| Module | What's there |
|---|---|
| Masters | Items (yarn, dyes & chemicals, packing, grey / colored / finished fabric), parties, units, locations, machines, processes (labour rates), BOM / dye recipes |
| Purchase | Purchase order → GRN (lot/batch) → purchase bill (GST) → supplier payment; pending PO report |
| Inventory | Stock by location & lot (Main Store, Knitting Factory, Color Factory, FG Store), stock ledger, yarn issue to knitting, grey transfer to color factory, opening stock / adjustments |
| Production | Knitting (yarn in → grey lot out), dyeing (grey lot + dyes & chemicals → colored), finishing & packing (→ finished rolls/kg); wastage and labour on each entry |
| Wastage | Wastage by stage with quantity, %, value and scrap recovery |
| Costing | Exact lot-wise costing sheet: raw material + direct labour + overheads + wastage = total, cost per kg / roll / meter; item-wise costing; overhead absorption |
| Sales | Sales order → delivery challan → GST invoice (CGST/SGST or IGST by state), party-wise price list |
| Customers | Customer master with credit limit & credit days, receipts, receivables with ageing and over-limit alerts |
| Finance & Accounts | Receipts, payments, party ledger, receivables / payables, GST summary |
| Reports | Purchase, stock, production, wastage, costing, item-wise costing, batch/lot tracking, profitability, sales, outstanding, GST, MIS dashboard; all exportable to CSV and printable |
| User Management | Users, department roles & permissions, company settings, backup & restore |

## Department logins

Every user gets a **role**, and the role decides which screens and reports that person can use.
The admin manages roles under *User Management → Roles & Permissions*.

Each of the 24 areas (purchase orders, GRN, knitting, dyeing, invoices, stock reports and so on) gets one level:

| Level | Meaning |
|---|---|
| No access | Hidden from the menu and blocked on the server |
| View | Can open, search and print |
| Add & edit | Can also enter new entries and change them |
| Full | Can also delete |

Ready-made roles: Management, Purchase Department, Store / Inventory, Knitting Department, Dyeing / Color Department,
Finishing & Packing, Sales Department, Finance & Accounts, and Data Entry (all modules). Edit them or add your own.
Role changes take effect immediately for everyone with that role.

The *Administrator* role always has full access, including users, roles, settings and backups.
People without the MIS dashboard permission get a home page with only their own screens.

## How costing works

Every kg of stock carries its cost split into buckets: yarn, dyes & chemicals, packing, knitting / dyeing / finishing labour, overhead and wastage.
When a lot moves from knitting to dyeing to finishing, its cost moves with it, and each stage adds its own chemicals, labour and wastage.
Wastage cost is the share of the input's cost that ended up as waste (less any scrap sale value).
Each month's overheads are spread over the kg finished in that month.

Stock and costs are recalculated from the documents every time, so editing or deleting an old entry keeps everything consistent.
The server rejects any entry, edit or delete that would make stock go negative (this can be switched off in Settings).

## Data

Everything is stored in an **SQLite database**, `data/erp.sqlite`, using the SQLite engine built into Node.js (nothing extra to install).

- One table per area (`items`, `parties`, `invoices`, `knitting` …). Each row holds the full record as JSON, plus readable columns `doc_no`, `doc_date` and `label`, so the file can be browsed in tools such as DB Browser for SQLite.
- Every save writes only the rows that changed, inside one transaction, so a save is stored completely or not at all. A power cut cannot leave a half-written database.
- While the server runs you will also see `erp.sqlite-wal` and `erp.sqlite-shm` next to it. They are part of the database: never delete them, and don't copy the `.sqlite` file by hand while the server runs.
- **Backups:** *Settings & Backup → Download backup* (a JSON file you can restore) or *Download database (SQLite)* (a consistent copy of the database file). A restore first saves the current database as `erp-before-restore-<time>.sqlite`.

**Moving from the older JSON version:** on the first start of this version, if `data/erp.sqlite` does not exist yet and `data/db.json` does, everything in `db.json` is imported automatically and the server prints how many records it brought over. `db.json` is left unchanged as a safety copy and is not used after that; you can archive it once you are happy.

## Project layout

```
server.js            HTTP server + REST API
server/db.js         SQLite storage (node:sqlite), JSON import from older versions
server/engine.js     stock replay, lot costing, wastage, accounts, all reports
server/seed.js       base records + demo data
server/auth.js       password hashing
public/index.html    single page app
public/js/schemas.js every screen (fields, line grids, auto-fill rules)
public/js/forms.js   generic list / form / print engine
public/js/pages.js   dashboard, reports, settings
public/js/app.js     login, navigation, routing
public/js/shared.js  GST / totals code shared by server and browser
```
