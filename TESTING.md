# Testing the ERP, department by department

This walkthrough runs one complete production cycle through the ERP: buying yarn, knitting, dyeing and finishing at outside agencies, selling, collecting payment and paying an agency.
Each department signs in with its own login and does only its own part.
Every step lists what you should see. If the ERP shows something different, note the step number.

It takes about 45 minutes. Do it in the order below, because each department uses what the previous one entered.

## Before you start

1. Install Node.js LTS (22.13 or newer) from https://nodejs.org.
2. Use a fresh, empty database. If you have used the ERP before, stop the server and rename the `data` folder to `data-old` so a new one is created (the database is `data/erp.sqlite`).
3. Double-click `start.bat`. The ERP opens at http://localhost:3000.
4. Use one browser for the whole test. To switch department, click the sign-out icon at the bottom left of the menu.

All entries use today's date. Don't change the dates, because the costing depends on everything falling in the same month.

---

## Step 1 — Administrator: create the department logins

Sign in as **admin / admin123**.

Go to **User Management → Users → New user** and create these 8 logins, all with password `pass123`:

| Username | Role / department |
|---|---|
| purchase1 | Purchase Department |
| store1 | Store / Inventory |
| knitting1 | Knitting Department |
| dyeing1 | Dyeing / Color Department |
| finishing1 | Finishing & Packing |
| sales1 | Sales Department |
| accounts1 | Finance & Accounts |
| manager1 | Management |

Then **Settings → Inventory**: tick *Finished rolls are weighed one by one* and save. (Normally rolls are only counted and go out at each lot's average; this walkthrough weighs them to show the roll-by-roll tracking. Step 12b checks the average.)

✅ **Check:** The Users list shows all 8, each with its department name.
✅ **Check:** **User Management → Roles & Permissions** lists 9 roles. Open *Knitting Department* and you'll see a table of every area with No access / View / Add & edit / Full.

---

## Step 2 — Purchase Department (purchase1)

**Masters → Items → New item**. Add these 7 items:

| Code | Name | Category | Unit | GST % | Standard rate |
|---|---|---|---|---|---|
| Y30 | Cotton Yarn 30s | Yarn | Kg | 5 | 250 |
| DRED | Reactive Red | Dyes & Chemicals | Kg | 18 | 500 |
| SODA | Soda Ash | Dyes & Chemicals | Kg | 18 | 40 |
| POLY | Poly Bag | Packing Material | Nos | 18 | 5 |
| GSJ | Grey Single Jersey | Grey Fabric | Kg | 5 | 0 |
| CSJ | Dyed Single Jersey | Colored Fabric | Kg | 5 | 0 |
| FSJ | Finished Single Jersey | Finished Goods | Kg | 5 | 400 |

✅ **Check:** Try to add another item named `cotton yarn 30s`. The ERP refuses because the name already exists.

**Masters → Parties → New party**: *Shree Mills*, type **Supplier**, state **West Bengal**.

Now the two job-work agencies. **Masters → Parties → New party**:
- *Maa Tara Knitting*, type **Job Worker**, state West Bengal. Under *Job work agency*, tick **Does knitting** and set **Knitting rate 9**.
- *Bengal Dyeing House*, type **Job Worker**, state West Bengal. Tick **Does dyeing / color** with **Dyeing rate 15**, and **Does finishing & packing** with **Finishing rate 6**.

✅ **Check:** **Masters → Locations** now lists *Maa Tara Knitting* and *Bengal Dyeing House* (type Job Worker). The ERP makes a stock location for each agency to hold the material sent to it.

**Masters → BOM / Recipes → New recipe**: name *Red Recipe*, stage *Dyeing*, lines **DRED 0.02** and **SODA 0.1** (quantity per kg of fabric).

**Purchase → Purchase Orders → New**: supplier Shree Mills, 4 lines:

| Item | Qty |
|---|---|
| Y30 | 1000 |
| DRED | 20 |
| SODA | 100 |
| POLY | 50 |

✅ **Check:** Rate and GST % fill in by themselves (Y30 → 250 and 5%).
✅ **Check:** After saving it's **PO-0001**. Totals: taxable **2,64,250.00**, CGST **7,532.50**, SGST **7,532.50**, grand total **2,79,315.00**.
✅ **Check (access):** The menu has no Production, Sales or Finance. Typing `localhost:3000/#/list/invoices` in the address bar shows **No access**.

---

## Step 3 — Store / Inventory (store1)

**Purchase → Goods Receipt (GRN) → New**: supplier Shree Mills, *Against PO* = PO-0001.

✅ **Check:** 4 lines load by themselves with the PO quantities.

✅ **Check:** the **Lot no** column shows *new on save* on the yarn line and *no lot* on the dye, soda and poly bag lines. You never type a lot number. Save → **GRN-0001**.

✅ **Check:** **Inventory → Stock Summary** shows Cotton Yarn 30s, lot **L-0001** (given by the GRN), **1,000 kg** at Main Store, value **2,50,000.00**.

**Inventory → Yarn Issue to Knitting → New**: knitting agency **Maa Tara Knitting**, item Y30, yarn lot **L-0001**, qty **2000**. Save.

✅ **Check:** The ERP refuses: *"Not enough stock … short by 1000"*.

Change qty to **600** and save → **TRF-0001**.

✅ **Check:** **Inventory → Stock Summary** shows 600 kg of lot L-0001 at **Maa Tara Knitting** and 400 kg at Main Store.
✅ **Check:** Click **Print** on TRF-0001. It prints as a **JOB WORK DELIVERY CHALLAN** with *Sent for job work to: Maa Tara Knitting* and a line for the agency's signature.

---

## Step 4 — Purchase Department again (purchase1)

**Purchase → Purchase Bills → New**: supplier Shree Mills, supplier bill no **SM/101**, *Against GRN* = GRN-0001.

✅ **Check:** Lines load with GST. Grand total **2,79,315.00** → **PB-0001**.

---

## Step 5 — Finance & Accounts (accounts1)

**Finance & Accounts → Supplier Payments → New**: supplier Shree Mills.

✅ **Check:** *Current balance* shows **₹ 2,79,315.00 Cr** (we owe them).

Amount **100000**, mode Bank Transfer: boxes for *NEFT / RTGS / IMPS*, *UTR no* and the supplier's bank appear. Choose NEFT, UTR **SBIN52026110300001**. Save.

---

## Step 6 — Knitting Department (knitting1)

✅ **Check (access):** The home page shows only knitting analytics (no ₹ figures) and the screens for Inventory (stock, send grey for dyeing), Production (knitting, agency summary, reports) and Wastage. There is no Dashboard with sales figures.

**Production → Knitting → New**.

✅ **Check:** The note at the top says *Yarn issued to agencies: Maa Tara Knitting (L-0001 600 Kg)*. Lot no shows *from the yarn lot*; job rate is **8** (the standard rate from Masters → Processes).

Agency / unit: **Maa Tara Knitting**.

✅ **Check:** Job rate changes to **9**, the agency's own rate.

Yarn consumed: item Y30, yarn lot **L-0001 — 600 Kg**, qty **600**.

✅ **Check:** Lot no now shows **L-0001**: the grey fabric keeps the yarn's lot number.

Grey fabric produced: **GSJ**, output qty **585**, rolls **25**.

✅ **Check:** Wastage fills in as **15** kg (2.50%). Job charges fill in as **5,265** (585 × 9).

Grey fabric sent to: **Bengal Dyeing House**. Save → **KNT-0001**.

✅ **Check:** **Inventory → Stock Summary** shows lot **L-0001**, **585 kg / 25 rolls** of grey fabric at **Bengal Dyeing House**, with no transfer entry needed. Nothing is left at Maa Tara Knitting.

✅ **Check (access):** Typing `localhost:3000/#/list/dyeing` shows **No access**.

---

## Step 7 — Dyeing / Color Department (dyeing1)

**Production → Dyeing / Coloring → New**: agency / unit **Bengal Dyeing House**.

✅ **Check:** *Dyed fabric sent to* fills in as **Bengal Dyeing House**, because this agency also finishes. Job rate is **15**.

Grey fabric GSJ, lot no **L-0001**.

✅ **Check:** Input qty fills in as **585**.

Pick dye recipe **Red Recipe**.

✅ **Check:** Two chemical lines appear: **Reactive Red 11.7** and **Soda Ash 58.5**.

Color **Red**, colored fabric produced **CSJ**, output qty **570**.

✅ **Check:** Wastage **15**, job charges **8,775** (585 × 15). Save → **DYE-0001**.

The dyes and chemicals come from your Main Store here. If an agency uses its own, leave that table empty: its rate then covers them.

---

## Step 8 — Finishing & Packing (finishing1)

**Production → Finishing & Packing → New**: agency / unit **Bengal Dyeing House**, colored fabric CSJ, lot **L-0001**. Input qty fills in as **570**; job rate **6**.

Packing materials: **POLY, qty 24**. Finished goods produced **FSJ**.

**Roll weights (kg):** type the weight of each of the 24 rolls with + between them. For this test, 23 rolls of 23.3 kg and one of 24.1 kg: `23.3 + 23.3 + …` (23 times) `+ 24.1`. Meters **2200**.

✅ **Check:** Output qty fills in as **560** and rolls as **24** by themselves. Wastage **10**, job charges **3,360**. Save → **FIN-0001**. The rolls go to the Finished Goods Store.

---

## Step 9 — Finance & Accounts (accounts1)

**Finance & Accounts → Expenses → New**: expense head *Electricity*, amount **11200**, paid to CESC. *Add to production cost* ticks itself (electricity is a factory expense). Save.

---

## Step 10 — Sales Department (sales1)

**Customers → Customer Master → New**:
- *Kolkata Garments*, state West Bengal, credit limit **100000**, credit days 30
- *Odisha Traders*, state **Odisha**, *UPI phone no / UPI ID* **odisha@oksbi**

**Sales → Party Price List → New**: Kolkata Garments, item FSJ, rate **420**.

**Sales → Sales Orders → New**: Kolkata Garments, item FSJ, qty **300**.

✅ **Check:** Rate fills in as **420** from the price list.
✅ **Check:** On Save, a warning says the customer will be above the ₹1,00,000 credit limit. Click **Save anyway** → **SO-0001**.

**Sales → Delivery Challans → New**: Kolkata Garments, against **SO-0001**.

✅ **Check:** Qty 300 loads. Choose lot **L-0001 — 560 Kg · 24 rolls**. The Rolls button fills in by itself as **13 · 23.3 + … + 20.4**: rolls 1–12 whole (279.6 kg) and 20.4 kg cut from roll 13. Save → **DC-0001**.

To send particular rolls instead, click the Rolls button: tick whole rolls, or type fewer kg to cut one. The quantity follows what you choose.

**Sales → Invoices → New**: Kolkata Garments, against **DC-0001**. Save, and confirm the credit warning.

✅ **Check:** **INV-0001**: taxable **1,26,000.00**, CGST **3,150.00**, SGST **3,150.00**, total **1,32,300.00**.
✅ **Check:** Click **Print**. A tax invoice opens with the amount in words.

**Invoices → New**: Odisha Traders, item FSJ, lot L-0001, qty **100**, change rate to **430**. Save → **INV-0002**.

✅ **Check:** Tax shows as **IGST 2,150.00** (other state), with no CGST/SGST. Total **45,150.00**. The rolls are **6**: the 2.9 kg left on roll 13, rolls 14–17 whole, and 3.9 kg cut from roll 18. **Print** shows Qty 100 and Rolls 6, with each roll's kg under the item.

**Invoices → New**: Odisha Traders, FSJ, lot L-0001, qty **500**. Save.

✅ **Check:** The ERP refuses with *"Not enough stock … short by 340"*. Only 160 kg of lot L-0001 is left: 560 − 300 on the challan − 100 on INV-0002.

---

## Step 11 — Finance & Accounts (accounts1)

**Customers → Payment Receipts → New**: Kolkata Garments, amount **50000**, mode UPI. Save.

Agencies are paid like suppliers. Their job charges come from the knitting, dyeing and finishing entries.

**Finance & Accounts → Supplier Payments → New**: supplier **Maa Tara Knitting**.

✅ **Check:** *Current balance* shows **₹ 5,265.00 Cr** (585 kg × ₹9 knitting charges).

Amount **4000**, mode Cash. Save.

✅ **Check:** **Finance & Accounts → Party Ledger**, party Maa Tara Knitting: *Knitting charges, lot L-0001, 585 kg* 5,265.00, then the payment, ending at **1,265.00 Cr**.
✅ **Check:** **Finance & Accounts → Payables** lists Shree Mills **1,79,315.00**, Bengal Dyeing House **12,135.00** (8,775 dyeing + 3,360 finishing) and Maa Tara Knitting **1,265.00**.
✅ **Check:** **Finance & Accounts → Labour Payable** shows **₹ 0.00**. It is only for workers in your own factory; agency work is paid through the agency's account.

---

## Step 12 — Management (manager1): check the numbers

Sign in as manager1. You should see the full **Dashboard**.

| Where | What you should see |
|---|---|
| Dashboard | Finished this month **560 kg**, avg cost **₹333.77/kg**; Open sales orders **0**; material in process: yarn in store **400 kg**, finished goods **160 kg** |
| Production → Agency Summary | Bengal Dyeing House: work *Color (Dyeing), Finishing & Packing*, 2 entries, job charges **12,135.00**, payable **12,135.00**. Maa Tara Knitting: 1 entry, job charges **5,265.00**, payable **1,265.00**. Nothing lying at either |
| Costing → Lot Costing Sheet | Lot L-0001, 560 kg, total cost **1,86,910.00**; cost/kg **333.77**, cost/roll **7,787.92**, cost/mtr **84.96**; overhead **11,200.00**, packing **120.00** |
| Wastage → Wastage Report | Knitting 15 kg, Dyeing 15 kg, Finishing 10 kg |
| Production → Batch / Lot Tracking | L-0001: supplier Shree Mills, received **1,000 kg**; yarn 600 → FG 560, **yield 93.33%**, sold 400, FG stock 160 |
| Inventory → Stock Summary | Main Store: yarn 400 kg, Reactive Red 8.3 kg, Soda Ash 41.5 kg, Poly Bag 26. Nothing left at either agency |
| Inventory → Finished Goods Rolls | L-0001, color **Red**, **160 kg in 7 rolls**: 19.4 + 23.3 + 23.3 + 23.3 + 23.3 + 23.3 + 24.1 |
| Reports → Profitability | Sale value **1,69,000.00**, cost **1,33,507.14**, profit about **35,493** |
| Finance → Receivables | Kolkata Garments **82,300.00**, Odisha Traders **45,150.00** |
| Finance → Payables | Shree Mills **1,79,315.00**, Bengal Dyeing House **12,135.00**, Maa Tara Knitting **1,265.00** |
| Finance → Party Ledger (Kolkata Garments) | Ends at **82,300.00 Dr** |
| Finance → GST Summary | Net GST **−6,615.00** (more input credit than output tax this month) |

How the ₹1,86,910 lot cost adds up:
yarn 600 × 250 = 1,50,000
\+ chemicals 11.7 × 500 + 58.5 × 40 = 8,190
\+ packing 24 × 5 = 120
\+ job charges 5,265 + 8,775 + 3,360 = 17,400
\+ overhead 11,200
= **1,86,910**

Part of this total shows in the *Wastage* column: the share of cost that went into the 40 kg of waste.

✅ **Check (access):** manager1 cannot open User Management → Users (**No access**).

---

## Step 12b — Bank, expenses, staff, CRM, godowns and approvals (admin, then accounts1)

Sign in as **admin**.

1. **Dashboard**: a *Today* card (sales today, this month, collected and spent today, bank & cash) and an *Alerts* card sit above the sales chart.
2. **Finance & Accounts → Bank & Cash Accounts → New**: *SBI Current*, opening balance **50000**. Save. (*Cash in Hand* is already there.)
3. **Customer Receipts → New**: click *Customer* and type **odis tra**.
   ✅ **Check:** the list keeps only *Odisha Traders* (every dropdown searches this way). Press **Enter** to pick it. In *Received in more than one way?* add two lines: *Cash* **1000**, and *UPI* **2000** (its account fills in as SBI Current).
   ✅ **Check:** *Amount received* shows **3000** by itself. Save.
   ✅ **Check:** the UPI line's *UPI phone / ID* fills in as **odisha@oksbi** (from the customer master).
   ✅ **Check:** **Bank & Cash Book**: SBI Current **₹52,000**; Cash in Hand is up ₹1,000.
   Then **Customer Receipts → New** again: Odisha Traders, **500**, mode *UPI*. *Paid from UPI* reads odisha@oksbi. Change the mode to *Cheque*.
   ✅ **Check:** the UPI box goes; *Cheque no* (required), *Cheque date* and *Bank & branch (on the cheque)* appear. Fill **004512**, today, *Axis Bank, Cuttack*. Save.
   ✅ **Check:** the receipts list shows *004512 dt …, Axis Bank, Cuttack* under *Details* and **Not cashed** under *Cheque*.
   ✅ **Check:** **Bank & Cash Book**: SBI Current is still **₹52,000**, and **Cheques Not Cashed** lists cheque 004512 (the dashboard warns about it too). A cheque counts only once it is cashed.
   Open the receipt: *Cheque status* reads *Not cashed yet*. Fill *Cheque cashed (cleared in bank) on* = today. Save.
   ✅ **Check:** SBI Current is now **₹52,500**; the cheque leaves *Cheques Not Cashed* and shows in Odisha Traders' party ledger.
4. **Expenses → New**: head *Transport*, **800**, paid to Sharma Transport.
   ✅ **Check:** *Add to production cost* stays unticked (transport is not a factory cost). Save.
5. **Staff & Salary → Staff → New**: *Ramu*, department Godown, salary **15000** a month. Save.
6. **Attendance → New** for today: Ramu is listed as *Present*; change him to *Absent*. Save.
7. **Salary & Advances → New**: employee Ramu, *Salary for month* = this month.
   ✅ **Check:** *Salary position* reads *Due ₹ 14,500.00 for 29 of 30 days* (in a 30-day month) and *Amount paid* fills in. Save.
8. **CRM → Leads & Follow-ups → New**: *Howrah Kids Wear*, mobile 98300 12345; in the follow-up line write *Asked for rates*, next follow-up **tomorrow**. Save.
   ✅ **Check:** the lead's *Next follow-up* is tomorrow; **Follow-ups Due** lists it.
9. **Masters → Locations & Godowns → New**: *Godown 2*, type *Godown*. Save. Then **Inventory → Godown Transfer → New**: to Godown 2, person responsible Ramu, item FSJ, lot **L-0001**, **20** kg (its rolls are picked by themselves). Save.
   ✅ **Check:** **Godown Stock**: L-0001 shows 140 kg in the Finished Goods Store and **20 kg in Godown 2**, 160 kg in all.
10. **Settings → Inventory**: untick *Finished rolls are weighed one by one*. **Inventory → Opening / Adjustment → New**: location Godown 2, item FSJ, qty **1000**, rolls **300**, rate 400 (no roll weights column now). Save. Then a **Delivery Challan → New** for Kolkata Garments from Godown 2, item FSJ, that new lot, **100** kg.
    ✅ **Check:** *Rolls* fills in as **30** by itself (1000 kg in 300 rolls). Leave without saving.
11. **Settings → Approvals**: tick *Staff changes and deletions … wait for an administrator's approval*. Save settings. Make an expense *Office Expenses* **300** as admin.
12. Sign in as **accounts1**, open that expense, change the amount to **350**, save.
    ✅ **Check:** the message says it was sent for approval; the expense still shows **300**.
13. Sign in as **admin** → **Admin → Approvals**: the request shows *amount 300 → 350* by accounts1. Click **Approve**.
    ✅ **Check:** the expense is now **350**, last edited by accounts1. **Activity Log** lists the sign-ins, the request and the approval.
14. Untick the approval setting again.

---

## Step 13 — Protection checks (admin)

| Try this | Expected |
|---|---|
| Delete GRN-0001 | Refused: it's billed and its yarn has been used |
| Delete item Y30 | Refused: it's used in PO-0001 |
| Edit user store1, untick **Active**, save; then sign in as store1 | Sign-in refused |
| Open the ERP on a phone (same Wi-Fi: `http://<PC-IP>:3000`) | Menu collapses behind the ☰ button; pages fit the screen |

---

## What each login should see

| Login | Can open | Must NOT open |
|---|---|---|
| purchase1 | Masters, purchase orders, bills, purchase & stock reports | Production, sales, receipts, users |
| store1 | GRN, yarn issue, opening stock, stock reports | Production, invoices, bills, payments |
| knitting1 | Knitting (the grey fabric goes to the dyeing agency chosen on the entry), send grey for dyeing for fabric kept at the knitter, production & stock reports | Dyeing, finishing, sales, GRN, yarn issue |
| dyeing1 | Dyeing, production & stock reports | Knitting, finishing, sales, purchase |
| finishing1 | Finishing & packing, production & stock reports | Knitting, dyeing, sales, GRN |
| sales1 | Customers, leads & follow-ups, quotations, price list, orders, challans, invoices, sales reports | Production, bills, payments, expenses, bank, salaries |
| accounts1 | Receipts, payments, bills, expenses, bank & cash, electricity bills, loans & EMIs, staff & salaries, invoices (view only), accounts/GST/costing reports, dashboard | Production screens, users, approvals, activity log |
| manager1 | Everything except users and roles | Users, roles |

A blocked screen shows **No access**, even when you type its address directly.

---

## Automated version of this test

The same scenario runs automatically, with a browser signing in as each department:

```
npm test
```

It needs Node.js 22.13 or newer and Google Chrome or Microsoft Edge. It uses a temporary database, so your real data is never touched. It runs four checks in turn: the storage test (data and sign-ins survive restarts, old `db.json` import), the API rules (including cheque / UPI / bank transfer details, cheques counting only once cashed, split receipts, bank book and reconciliation, expenses, electricity bills, salary from attendance, salary privacy, EMIs, leads, quotations, godowns, lot number format, job work delays, processing status, GSTR-1 / 3B, approvals and the activity log), the two-tab sign-in test, and this department walkthrough. Each prints a pass/fail line for every check; the walkthrough ends with *ALL 137 CHECKS PASSED*.

It also checks, for every department login, that the menu, each screen and the server all agree on what that login may open or change: about 200 checks per login.
