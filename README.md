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
| Masters | Items (yarn with count / specification and colour, dyes & chemicals, packing, grey / colored / finished fabric) with their **opening stock** (stock brought over from the old software), parties (suppliers, customers and **job-work agencies** with the work each does and its rate per kg), units, locations & **godowns**, **salesmen** (area / territory, phone; each customer has its salesman), machines, processes (standard rates), BOM / dye recipes |
| Purchase | Purchase order → GRN (each yarn / fabric line gets its lot number, `L-0001` or a format of your own such as `MH-2026-001`) → purchase bill (GST, transport) with its payment status (paid / part paid / unpaid) → supplier payment; pending PO report |
| Inventory | Stock by location & lot; **yarn stock** (opening, purchased, sent to knitting, used, available in store, at knitting houses); **godown stock** (kg and rolls of each fabric in each godown side by side); stock ledger; yarn issue to a knitting agency (job work challan with expected fabric, job rate and expected date); send grey for dyeing (colour and shade wanted, rate, expected date); **godown transfer** (rolls, kg, person responsible); opening stock / adjustments |
| Production | **Lot BOM**: the materials planned for each lot (yarn, dyes & chemicals, packing per kg of fabric); a dyeing or finishing entry for the lot fills its materials from it, and **Lot BOM vs Actual** compares plan and use. Knitting, dyeing and finishing & packing, each done by the agency chosen on the entry (or your own factory), with average roll weight and the yarn still at the knitter. Knitting can come back **in parts** (1,000 kg of yarn given, 300 kg of grey, then 400 kg …): the yarn used fills in from the grey received and the wastage, and the last delivery uses up the rest. Wastage in **kg and %** on every entry (type either). **Knitting Deliveries**: yarn given and grey received per agency and lot, delivery by delivery, with wastage kg and %. Finished rolls go to the godown chosen. Rolls are counted, not weighed: dyed and finished output keeps the rolls taken in (weighing each roll, `20.2 + 50.3 + 39.5`, is an option in Settings). **Job Work Register**: every send to an agency, how much is still there, overdue sends. **Processing Status**: every lot at a dyeing / finishing agency as 🟡 material sent → 🔵 processing started → 🟠 colouring → 🟣 finishing → 🟢 finished & ready → ✅ received. **Agency Summary**: kg sent, worked, delivered, wastage %, lying there, late sends, charges and what is owed |
| Wastage | Wastage by stage with quantity, %, value and scrap recovery |
| Costing | Exact lot-wise costing sheet: raw material + job / labour charges + overheads + wastage = total, cost per kg / roll / meter; item-wise costing; overhead absorption |
| Sales | **Quotation** (to a customer or a new prospect) → sales order (colour, kg or rolls; rolls alone are turned into kg at the average roll weight) → delivery challan → GST invoice (CGST/SGST or IGST by state, discount, transport) from any godown, with paid / balance / overdue on each invoice; party-wise price list; each invoice and receipt carries the customer's **salesman**; **Sale Bills & Dispatch Log** (every bill with customer & city, salesman, fabric & lot, kg, rolls, bill value, collected and how it was paid). Finished lots go out roll by roll: whole rolls in order and the last one cut, or the rolls you pick |
| Finance & Accounts | Receipts and payments in one mode or **split** (part cash, part bank, UPI, cheque, **card machine (EDC / POS)**, online), with the **details of each mode** (cheque no., date and bank; UPI phone / ID; NEFT / RTGS / IMPS and UTR; who took the cash); **cheques count only once cashed** (Cheques Not Cashed list); **bank & cash accounts**, bank book, deposits / withdrawals / transfers / bank charges, **bank reconciliation**; **expenses** by head (transport, electricity, rent, salary, job work, repairs, office, phone, misc.), with factory expenses going into production cost; **electricity bills** (bill, due date, paid); **loans & EMIs** (EMIs paid and left, next due date); party ledger, receivables / payables, **Salesman-wise Collections** (cash, UPI, card, RTGS / NEFT and cheque collected by each salesman, kg and rolls billed, what their customers owe), labour payments and Labour Payable for your own factory |
| Staff & Salary | Staff (department, designation, joining date, monthly salary or daily wage), daily **attendance** (present, half day, absent, paid leave, holiday), attendance sheet for the month, **salary & advances** (the form works out the salary due from the attendance; advances are recovered from later salaries), salary register |
| GST Reports | GST summary, sales register, purchase register, **GSTR-1 data** (B2B, B2C large, B2C small, HSN summary, documents issued), **GSTR-3B summary** (outward supplies, ITC, net tax), party GST details. Your accountant should check them before filing |
| Reports | All of the above, plus purchase, production, batch/lot tracking, profitability and sales; every report exports to CSV and prints |
| Admin | Users, department roles & permissions, **approvals** (staff changes and deletions of saved entries can wait for the administrator), **activity log** (sign-ins and every entry created, changed, deleted or approved), company settings, backup & restore |
| Remote Support | A support colleague can **see your ERP screen and, with your permission, help on it** — nothing to install. You share your browser tab (and, if you like, your microphone); a bar stays across the top with a one-time code to read out and a **Stop** button; control stays off until you switch it on. Only staff with the *Remote support* permission can help; the picture and voice go straight between the two browsers |
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
- **Delivered in parts.** Give the agency 1,000 kg and it may bring back 300 kg of grey, then 400 kg, and so on: make one knitting entry per delivery. Choosing the agency fills its yarn lot (when it holds one) and shows *This yarn lot at the agency*: yarn given, deliveries before this one and their wastage. Type the grey received; the yarn used fills in as grey + wastage. Type the wastage in kg or in % of the yarn, the other fills in; it starts at the loss expected on the yarn issue (*Expected grey fabric*, 2.5% less than the yarn unless changed). On the last delivery tick **Last delivery**: all the yarn of the lot still at the agency is counted as used, and what did not become fabric is the wastage. Yarn the agency returns is sent back to the store first (*All Transfers*). You can still type the yarn used yourself.
- **Production → Knitting Deliveries** shows each agency and yarn lot: yarn given, every delivery (*01-11-2026 · KNT-0007: 300 kg grey*, with the yarn it used and its wastage in kg and %), grey received in all, wastage kg and %, yarn sent back, yarn still there and *Not started*, *Part received* or *Completed*. Tick *Include completed* for lots fully delivered.
- **Wastage in kg and %.** On knitting, dyeing and finishing entries type the wastage in kg or in % (of the yarn, or of the fabric taken in): the other fills in. The lists and the Wastage Report show both.
- **Dyeing** and **Finishing & Packing** work the same way: choose the agency, and the lot list shows only what is lying there. A dyeing house that also finishes keeps the dyed fabric; otherwise send it to the finishing agency. Finished rolls go to the Finished Goods Store.
- **Job charges** (rate × kg) go to the agency's Party Ledger as money owed, appear under Payables, and are paid in Supplier Payments.
- **Production → Agency Summary** shows what is lying at each agency right now, the kg it took in and delivered, its wastage %, its charges and what it is owed.

The built-in *Knitting Factory* and *Color Factory* are for work in your own factory, if any. Tick *Not in use* on them in Masters → Locations to hide them.

## Lot BOM (the materials of each lot)

*Production → Lot BOM* holds one bill of materials per lot number, for example lot `0987`: what each kg of its fabric should take.

- **Make one per lot.** Pick the lot from the list (every yarn and fabric lot in stock, with what it holds and its kg) or type a lot number that has not come in yet. *Lot size (kg)* fills in with the kg of the lot in stock. *Fabric to make* and *Color* are optional.
- **Materials per 1 kg of fabric.** Yarn is per kg of grey fabric knitted; dyes & chemicals per kg of fabric dyed; packing and other material per kg of fabric finished. *Used in* shows the stage each material belongs to (from its category), *For the whole lot* the quantity for the lot size, and the form totals the material cost per kg and for the lot at the rates in *Masters → Items*.
- **Copy materials from** a dye recipe or packing standard (*Masters → BOM / Recipes*: replaces that stage's materials) or from another lot's BOM (replaces all of them), then change what differs for this lot.
- **Applied to the lot.** When a dyeing entry takes the lot, its dyes & chemicals fill in from the lot's BOM for the kg taken in (500 kg at 0.02 = 10 kg), together with the color; a finishing entry fills its packing and the fabric to make. They follow the input kg until you change a line by hand. A knitting entry shows *Yarn as per lot BOM* beside the yarn consumed. Entries already saved are not changed.
- **Lot BOM vs Actual** (*Production*) puts each BOM beside what the lot's entries really used: per material, *As per BOM* (qty per kg × the kg that went through the stage), *Used*, the difference and % and a status: *As per BOM* (within 2%), *Over BOM*, *Under BOM*, *Not used*, *Not in BOM* (used but not planned) or *Not started*, with the cost of what was used. Click a line to open the lot's BOM; the BOM has a button back to its report.
- One BOM per lot: a second BOM for the same lot is refused, with the number of the one to open. A material in a lot BOM cannot be deleted from the items. The knitting, dyeing and finishing roles can make lot BOMs (*Lot BOM* in *Roles & Permissions*); every login can read them, so the entries can fill from them.

## Remote support

When someone needs help, open **Remote Support** in the menu — no download, it is part of the ERP.

- **Get help.** Click **Start sharing** and choose **This tab**. A bar appears across the top of the screen with a **6-character code**: read it to your support colleague. Turn on the microphone if you want to talk. Control is **off** until you tick **Allow support to control my screen**; untick it, or press **Stop sharing**, at any time. The bar stays with you even if you move to another page.
- **Give help** — staff with the *Remote support* permission (set in *Admin -> Roles & Permissions*). Type the code the user reads out, click **Connect**, and you see their screen and can talk back. Once they allow control, your clicks, scrolling and typing work on their ERP; to type, click a box on their screen and type in the small box above the picture.
- **Safe by design.** Both sides must be signed-in ERP users; a session is reached only by the one-time code and holds one helper; the user stays in control and can stop at once; and it only ever reaches the ERP in the browser, never the rest of the computer. Who shared and who helped is written to the activity log.
- **Needs** an address starting `https` (the live site is one) or `localhost`, and a modern browser (Chrome / Edge) — browsers allow screen sharing and the microphone only there. On a difficult network a TURN server can be set (settings `rtcIce`); most connections work without one.

## Money, staff and godowns

- **Bank & cash.** *Cash in Hand* is built in; add each bank account under *Finance & Accounts → Bank & Cash Accounts* with its opening balance. Every receipt, payment, expense, salary, EMI and paid electricity bill names the account it went through (cash goes to Cash in Hand by itself), and *Bank Entries* records cash deposited, cash withdrawn, transfers between accounts, bank charges and interest. The *Bank & Cash Book* shows each account's balance. For *Bank Reconciliation*, fill in "Cleared in bank on" on an entry when it appears in the bank statement. Entries made before the bank accounts existed can be counted in one bank from *Settings*.
- **Payment details.** Each mode asks for its own details: *Cheque* – cheque no. (required), cheque date, bank & branch; *UPI* – phone no or UPI ID and transaction ID; *Bank Transfer* – NEFT / RTGS / IMPS, UTR no, their bank (and, when paying a supplier, their account no & IFSC); *Card (EDC / POS)* – card (last 4 digits) and approval / slip no; *Online* – paid through and transaction ID; *Cash* – who took or got the cash and the receipt-book / voucher no. A party's bank, account, IFSC and UPI ID saved in the party master fill in by themselves. The details show in the receipts and payments lists, the printed voucher, the party ledger, the bank book and the customer card.
- **Cheques count only once cashed.** A cheque received or given does not count until *Cheque cashed (cleared in bank) on* is filled in: until then the customer still owes it (the invoice stays unpaid), the supplier is still owed, and the bank balance does not include it. From that date it counts everywhere: party ledger (dated the day it was cashed), bills, outstanding, bank book, dashboard collections. In a split receipt only the cheque part waits. *Finance & Accounts → Cheques Not Cashed* lists every cheque still waiting, with days waiting; the dashboard warns about them, and the receipts / payments lists show *Not cashed* or *Cashed (date)*. A cheque cannot be cashed before the date of its entry. Expenses, salaries, EMIs and bills paid by cheque leave the bank only once cashed as well.
- **Part payments and credit.** A receipt can be split (₹20,000 cash + ₹30,000 bank), each part with its own details. Whatever is not received stays on credit: each invoice shows paid, balance and *Overdue* once its credit days pass, and the customer's outstanding updates by itself.
- **Expenses** go under a head; factory heads (electricity, rent, repairs, machine running, factory overheads) are added to production cost unless unticked. Electricity bills have their own screen with the due date and the date paid.
- **Loans & EMI.** Each loan has its EMI, number of EMIs and first EMI date; *EMI & Loan Status* shows EMIs paid and left, the next due date and whether it is due today, in 3 days or overdue.
- **Staff & salary.** Mark attendance once a day (everyone starts as present). Monthly staff are paid the month's salary less absent days and half of each half day; daily-wage staff are paid for the days marked. Advances are recovered on later salary payments.
- **Godowns.** Finished goods can be kept in the Finished Goods Store and any location of type *Godown*. Finishing sends the rolls to the godown chosen, *Godown Transfer* moves rolls between godowns (each roll keeps its weight), and challans and invoices sell from the godown chosen.
- **Kg and rolls.** Billing is by kg; rolls are an average. Stock keeps kg and rolls together, and any kg taken from a lot (challan, invoice, transfer, dyeing, finishing) takes its rolls in proportion: a lot received as 1,000 kg in 300 rolls gives 30 rolls with 100 kg, and the last kg take whatever rolls are left. A roll count typed on a line is kept; rolls typed without kg give the kg at the lot's average (or at the average roll weight in *Settings*, 17 kg, where there is no lot yet, as on a sales order). Weighing each roll one by one can be switched on in *Settings*.
- **Opening stock on the item.** When moving from another software, type each item's old stock at the bottom of its form in *Masters → Items*: *Opening stock qty*, *Rate* (fills in from the standard rate; gives the value), *Kept at* (store, godown or agency), *Lot no* for yarn and fabric (automatic, or the old lot number typed in, with the same pop-up as a GRN), *Rolls* for fabric and *Stock as on* (blank = before every entry). It counts in every stock report, the stock ledger (*Opening stock*, which opens the item) and lot tracking, exactly like an opening stock entry. It cannot be lowered below what has already been used or sold, and its lot number cannot be changed once the lot has gone further. Only logins allowed to enter opening stock see these boxes. Stock of one item in several lots or places goes in *Inventory → Opening / Adjustment*.
- **Salesmen.** Add them in *Masters → Salesmen* (name, area / territory, phone) and give each customer its salesman in *Parties*. Choosing the customer on an invoice or receipt fills in its salesman (it can be changed on the entry); a bill or receipt without one counts under its customer's salesman.
- **Sale Bills & Dispatch Log** (*Sales*) and **Salesman-wise Collections** (*Finance & Accounts*) open on today, with *Today / This month / Last month / This FY* and a salesman filter. The dispatch log lists each bill with customer and city, salesman, each fabric with its lot, kg and rolls, bill value, money collected and how it was paid (*UPI*, *Cheque*, *Card (EDC / POS)* …, *Part paid*, *Unpaid*, *Cheque not cashed*), with a summary such as *3 invoices · 1,870 kg · 89 rolls*. Collections shows for each salesman (and *No salesman*) the cash, UPI, card, RTGS / NEFT and cheque money received in the period, the total, the kg and rolls billed, what their customers owe now, and cheques received but not cashed; click a salesman for their bills. A cheque counts on the day it is cashed. *Download PDF* opens the print window: choose *Save as PDF*.
- **Lot numbers.** `L-0001` by default; *Settings* can switch to a format such as `MH-{YYYY}-###` (MH-2026-001, starting again each year). Lots already given keep their numbers.
- **Automatic unless you type one.** On a GRN the *Lot no* box shows the next number greyed (*L-0013 (auto)*): leave it and that number is given on save, or type your own (for example the supplier's lot, *SM/4471*) and it is used instead, in capitals. On opening stock, type the number in the lot box and pick *New lot: …*. A typed number cannot be one already used, may hold letters, digits, - / . _ and spaces, and does not move the automatic series on. Once a lot has been issued, knitted, moved or sold its number can no longer be changed. When you type a lot number a **pop-up** explains it before it is used: *Your own lot number* (it follows the material through yarn issue, knitting, dyeing, finishing, challan and invoice; *Use SM/4471* or *Use the automatic number*), *already used* (where, with *Type another* or the automatic number) or *not allowed*. The *Saved* message lists the lot numbers given, e.g. *Saved GRN-0007 · lot numbers SM/4471 (typed), L-0013*.

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
