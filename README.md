# Majumdaar Hosiery ERP

A web-based ERP for a hosiery unit. It covers the full flow:

**Yarn purchase → knitting agency → dyeing agency → finishing & packing → godowns → sales → customer payment → accounts & GST**,
with one lot number from purchase to sale, kg and rolls side by side, wastage tracking and exact costing at every stage.

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
| Dashboard | Owner's view: today's sales, this month's sales, money collected and spent today, bank & cash balances; **alerts** for overdue invoices, job work past its expected date, EMIs and electricity bills due, follow-ups due, low stock and changes waiting for approval; then sales, profit, receivables, material at each stage, costing and wastage for any period |
| CRM | Customer master (phone, address, GSTIN, credit limit, credit days, payment terms), **leads & follow-ups** (each call or visit with the next date), follow-ups due, **customer card** (profile, outstanding, overdue, invoices with paid / balance, payments, open orders, leads), receipts, outstanding with ageing |
| Masters | Items (yarn with count / specification and colour, dyes & chemicals, packing, grey / colored / finished fabric), parties (suppliers, customers and **job-work agencies** with the work each does and its rate per kg), units, locations & **godowns**, machines, processes (standard rates), BOM / dye recipes |
| Purchase | Purchase order → GRN (each yarn / fabric line gets its lot number, `L-0001` or a format of your own such as `MH-2026-001`) → purchase bill (GST, transport) with its payment status (paid / part paid / unpaid) → supplier payment; pending PO report |
| Inventory | Stock by location & lot; **yarn stock** (opening, purchased, sent to knitting, used, available in store, at knitting houses); **godown stock** (kg and rolls of each fabric in each godown side by side); stock ledger; yarn issue to a knitting agency (job work challan with expected fabric, job rate and expected date); send grey for dyeing (colour and shade wanted, rate, expected date); **godown transfer** (rolls, kg, person responsible); opening stock / adjustments |
| Production | Knitting, dyeing and finishing & packing, each done by the agency chosen on the entry (or your own factory), with average roll weight and the yarn still at the knitter. Finished rolls go to the godown chosen. Rolls are counted, not weighed: dyed and finished output keeps the rolls taken in (weighing each roll, `20.2 + 50.3 + 39.5`, is an option in Settings). **Job Work Register**: every send to an agency, how much is still there, overdue sends. **Processing Status**: every lot at a dyeing / finishing agency as 🟡 material sent → 🔵 processing started → 🟠 colouring → 🟣 finishing → 🟢 finished & ready → ✅ received. **Agency Summary**: kg sent, worked, delivered, wastage %, lying there, late sends, charges and what is owed |
| Wastage | Wastage by stage with quantity, %, value and scrap recovery |
| Costing | Exact lot-wise costing sheet: raw material + job / labour charges + overheads + wastage = total, cost per kg / roll / meter; item-wise costing; overhead absorption |
| Sales | **Quotation** (to a customer or a new prospect) → sales order (colour, kg or rolls; rolls alone are turned into kg at the average roll weight) → delivery challan → GST invoice (CGST/SGST or IGST by state, discount, transport) from any godown, with paid / balance / overdue on each invoice; party-wise price list. Finished lots go out roll by roll: whole rolls in order and the last one cut, or the rolls you pick |
| Finance & Accounts | Receipts and payments in one mode or **split** (part cash, part bank, UPI, cheque, online), with the **details of each mode** (cheque no., date and bank; UPI phone / ID; NEFT / RTGS / IMPS and UTR; who took the cash); **cheques count only once cashed** (Cheques Not Cashed list); **bank & cash accounts**, bank book, deposits / withdrawals / transfers / bank charges, **bank reconciliation**; **expenses** by head (transport, electricity, rent, salary, job work, repairs, office, phone, misc.), with factory expenses going into production cost; **electricity bills** (bill, due date, paid); **loans & EMIs** (EMIs paid and left, next due date); party ledger, receivables / payables, labour payments and Labour Payable for your own factory |
| Staff & Salary | Staff (department, designation, joining date, monthly salary or daily wage), daily **attendance** (present, half day, absent, paid leave, holiday), attendance sheet for the month, **salary & advances** (the form works out the salary due from the attendance; advances are recovered from later salaries), salary register |
| GST Reports | GST summary, sales register, purchase register, **GSTR-1 data** (B2B, B2C large, B2C small, HSN summary, documents issued), **GSTR-3B summary** (outward supplies, ITC, net tax), party GST details. Your accountant should check them before filing |
| Reports | All of the above, plus purchase, production, batch/lot tracking, profitability and sales; every report exports to CSV and prints |
| Admin | Users, department roles & permissions, **approvals** (staff changes and deletions of saved entries can wait for the administrator), **activity log** (sign-ins and every entry created, changed, deleted or approved), company settings, backup & restore |
| Searchable dropdowns | Every dropdown (forms, item lines, report filters, settings) is a box you can type in: the list keeps only the choices containing all the words typed, in any order (*kolk gar* finds Kolkata Garments). Arrow keys move, Enter or Tab picks, Esc goes back |
| Guidance | Every entry screen says what is missing before you start (no agency yet, no yarn issued to the agency, no grey lot waiting there, chemicals or packing short, item in the wrong category or store), where the stock is instead, which step fixes it (a button, or which department to ask) and what comes next. Lines short of stock get a note underneath, and stock errors on saving say what to do |

## Department logins

Every user gets a **role**, and the role decides which screens and reports that person can use.
The admin manages roles under *User Management → Roles & Permissions*.

Each of the 34 areas (purchase orders, GRN, knitting, dyeing, invoices, bank, salaries, stock reports and so on) gets one level:

| Level | Meaning |
|---|---|
| No access | Hidden from the menu and blocked on the server |
| View | Can open, search and print |
| Add & edit | Can also enter new entries and change them |
| Full | Can also delete |

Ready-made roles: Management, Purchase Department, Store / Inventory, Knitting Department, Dyeing / Color Department,
Finishing & Packing, Sales Department, Finance & Accounts, and Data Entry (all modules). Edit them or add your own.
Role changes take effect immediately for everyone with that role.

The *Administrator* role always has full access, including users, roles, settings, backups, approvals and the activity log.
People without the MIS dashboard permission get a home page with only their own screens.
Salaries are seen only by roles with *Salaries & advances*; a role with only *Staff list & attendance* sees the staff without their pay. Bank balances are seen only with *Bank & cash*; other departments can still choose the account a payment went through.

**Approvals.** With *Settings → Approvals* turned on, when staff change or delete a saved bill, invoice, receipt, payment, expense, stock or production entry, the change waits under *Admin → Approvals* until the administrator (or a role allowed to approve) accepts it; the entry stays as it was until then. Staff can still correct entries they made themselves the same day. New entries are never held up.

## Job-work agencies

Knitting, dyeing and finishing & packing are done by outside agencies, several for each kind of work.
Add each agency once in *Masters → Parties*: type **Job Worker**, tick the work it does (knitting, dyeing / color, finishing & packing) and give its rate per kg.
The ERP then gives the agency a stock location of its own, named after it.

- **Yarn Issue to Knitting** sends yarn from the Main Store to the knitting agency you choose, and prints as a job work delivery challan.
- **Knitting** is entered when the agency delivers. Choose the agency: the yarn is taken from what was issued to it, the job rate fills in from the agency, and *Grey fabric sent to* names the dyeing agency the fabric goes to.
- **Dyeing** and **Finishing & Packing** work the same way: choose the agency, and the lot list shows only what is lying there. A dyeing house that also finishes keeps the dyed fabric; otherwise send it to the finishing agency. Finished rolls go to the Finished Goods Store.
- **Job charges** (rate × kg) go to the agency's Party Ledger as money owed, appear under Payables, and are paid in Supplier Payments.
- **Production → Agency Summary** shows what is lying at each agency right now, the kg it took in and delivered, its wastage %, its charges and what it is owed.

The built-in *Knitting Factory* and *Color Factory* are for work in your own factory, if any. Tick *Not in use* on them in Masters → Locations to hide them.

## Money, staff and godowns

- **Bank & cash.** *Cash in Hand* is built in; add each bank account under *Finance & Accounts → Bank & Cash Accounts* with its opening balance. Every receipt, payment, expense, salary, EMI and paid electricity bill names the account it went through (cash goes to Cash in Hand by itself), and *Bank Entries* records cash deposited, cash withdrawn, transfers between accounts, bank charges and interest. The *Bank & Cash Book* shows each account's balance. For *Bank Reconciliation*, fill in "Cleared in bank on" on an entry when it appears in the bank statement. Entries made before the bank accounts existed can be counted in one bank from *Settings*.
- **Payment details.** Each mode asks for its own details: *Cheque* – cheque no. (required), cheque date, bank & branch; *UPI* – phone no or UPI ID and transaction ID; *Bank Transfer* – NEFT / RTGS / IMPS, UTR no, their bank (and, when paying a supplier, their account no & IFSC); *Online* – paid through and transaction ID; *Cash* – who took or got the cash and the receipt-book / voucher no. A party's bank, account, IFSC and UPI ID saved in the party master fill in by themselves. The details show in the receipts and payments lists, the printed voucher, the party ledger, the bank book and the customer card.
- **Cheques count only once cashed.** A cheque received or given does not count until *Cheque cashed (cleared in bank) on* is filled in: until then the customer still owes it (the invoice stays unpaid), the supplier is still owed, and the bank balance does not include it. From that date it counts everywhere: party ledger (dated the day it was cashed), bills, outstanding, bank book, dashboard collections. In a split receipt only the cheque part waits. *Finance & Accounts → Cheques Not Cashed* lists every cheque still waiting, with days waiting; the dashboard warns about them, and the receipts / payments lists show *Not cashed* or *Cashed (date)*. A cheque cannot be cashed before the date of its entry. Expenses, salaries, EMIs and bills paid by cheque leave the bank only once cashed as well.
- **Part payments and credit.** A receipt can be split (₹20,000 cash + ₹30,000 bank), each part with its own details. Whatever is not received stays on credit: each invoice shows paid, balance and *Overdue* once its credit days pass, and the customer's outstanding updates by itself.
- **Expenses** go under a head; factory heads (electricity, rent, repairs, machine running, factory overheads) are added to production cost unless unticked. Electricity bills have their own screen with the due date and the date paid.
- **Loans & EMI.** Each loan has its EMI, number of EMIs and first EMI date; *EMI & Loan Status* shows EMIs paid and left, the next due date and whether it is due today, in 3 days or overdue.
- **Staff & salary.** Mark attendance once a day (everyone starts as present). Monthly staff are paid the month's salary less absent days and half of each half day; daily-wage staff are paid for the days marked. Advances are recovered on later salary payments.
- **Godowns.** Finished goods can be kept in the Finished Goods Store and any location of type *Godown*. Finishing sends the rolls to the godown chosen, *Godown Transfer* moves rolls between godowns (each roll keeps its weight), and challans and invoices sell from the godown chosen.
- **Kg and rolls.** Billing is by kg; rolls are an average. Stock keeps kg and rolls together, and any kg taken from a lot (challan, invoice, transfer, dyeing, finishing) takes its rolls in proportion: a lot received as 1,000 kg in 300 rolls gives 30 rolls with 100 kg, and the last kg take whatever rolls are left. A roll count typed on a line is kept; rolls typed without kg give the kg at the lot's average (or at the average roll weight in *Settings*, 17 kg, where there is no lot yet, as on a sales order). Weighing each roll one by one can be switched on in *Settings*.
- **Lot numbers.** `L-0001` by default; *Settings* can switch to a format such as `MH-{YYYY}-###` (MH-2026-001, starting again each year). Lots already given keep their numbers.

## How costing works

Every kg of stock carries its cost split into buckets: yarn, dyes & chemicals, packing, knitting / dyeing / finishing charges, overhead and wastage.
When a lot moves from knitting to dyeing to finishing, its cost moves with it, and each stage adds its own chemicals, job charges and wastage.
The lot number never changes on the way: the GRN gives it once (opening stock gets one the same way), knitting keeps the lot of the main yarn, dyeing and finishing keep the lot they take in, and the challan or invoice sells from that same lot. Dyes, chemicals and packing are used up in production, so they have no lot.
Wastage cost is the share of the input's cost that ended up as waste (less any scrap sale value).
Each month's overheads (expenses marked "add to production cost" and electricity bills) are spread over the kg finished in that month.

Stock and costs are recalculated from the documents every time, so editing or deleting an old entry keeps everything consistent.
The server rejects any entry, edit or delete that would make stock go negative (this can be switched off in Settings).

## Data

Everything is stored in an **SQLite database**, `data/erp.sqlite`, using the SQLite engine built into Node.js (nothing extra to install).

- One table per area (`items`, `parties`, `invoices`, `knitting` …). Each row holds the full record as JSON, plus readable columns `doc_no`, `doc_date` and `label`, so the file can be browsed in tools such as DB Browser for SQLite.
- The `activity` table is the activity log (who did what, and when); `approvals` holds changes waiting for the administrator.
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
