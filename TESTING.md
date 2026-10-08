# Testing the ERP, department by department

This walkthrough runs one complete production cycle through the ERP: buying yarn, knitting, dyeing, finishing, selling and collecting payment.
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

In the yarn line, type Lot / Batch **YB-1**. Save → **GRN-0001**.

✅ **Check:** **Inventory → Stock Summary** shows Cotton Yarn 30s, lot YB-1, **1,000 kg** at Main Store, value **2,50,000.00**.

**Inventory → Yarn Issue to Knitting → New**: item Y30, yarn lot YB-1, qty **2000**. Save.

✅ **Check:** The ERP refuses: *"Not enough stock … short by 1000"*.

Change qty to **600** and save → **TRF-0001**.

---

## Step 4 — Purchase Department again (purchase1)

**Purchase → Purchase Bills → New**: supplier Shree Mills, supplier bill no **SM/101**, *Against GRN* = GRN-0001.

✅ **Check:** Lines load with GST. Grand total **2,79,315.00** → **PB-0001**.

---

## Step 5 — Finance & Accounts (accounts1)

**Finance & Accounts → Supplier Payments → New**: supplier Shree Mills.

✅ **Check:** *Current balance* shows **₹ 2,79,315.00 Cr** (we owe them).

Amount **100000**, mode Bank Transfer. Save.

---

## Step 6 — Knitting Department (knitting1)

✅ **Check (access):** The home page shows only Inventory (stock, transfer to color factory), Production (knitting, reports) and Wastage. There is no Dashboard with sales figures.

**Production → Knitting → New**.

✅ **Check:** Lot no is already **L-0001** and labour rate is **8**.

Yarn consumed: item Y30, yarn lot **YB-1 — 600 Kg**, qty **600**. Grey fabric produced: **GSJ**, output qty **585**, rolls **25**.

✅ **Check:** Wastage fills in as **15** kg (2.56%). Labour amount fills in as **4,680**. Save → **KNT-0001**.

**Inventory → Transfer to Color Factory → New**: item GSJ, lot L-0001, qty **585**, rolls **25**. Save.

✅ **Check (access):** Typing `localhost:3000/#/list/dyeing` shows **No access**.

---

## Step 7 — Dyeing / Color Department (dyeing1)

**Production → Dyeing / Coloring → New**: grey fabric GSJ, grey lot **L-0001**.

✅ **Check:** Input qty fills in as **585**.

Pick dye recipe **Red Recipe**.

✅ **Check:** Two chemical lines appear: **Reactive Red 11.7** and **Soda Ash 58.5**.

Color **Red**, colored fabric produced **CSJ**, output qty **570**.

✅ **Check:** Wastage **15**, labour **8,775** (585 × 15). Save → **DYE-0001**.

---

## Step 8 — Finishing & Packing (finishing1)

**Production → Finishing & Packing → New**: colored fabric CSJ, lot **L-0001**. Input qty fills in as **570**.

Packing materials: **POLY, qty 24**. Finished goods produced **FSJ**, output **560**, rolls **24**, meters **2200**.

✅ **Check:** Wastage **10**, labour **3,360**. Save → **FIN-0001**.

---

## Step 9 — Finance & Accounts (accounts1)

**Costing → Overhead Entries → New**: category *Utilities (Power/Water)*, amount **11200**, paid to CESC. Save.

---

## Step 10 — Sales Department (sales1)

**Customers → Customer Master → New**:
- *Kolkata Garments*, state West Bengal, credit limit **100000**, credit days 30
- *Odisha Traders*, state **Odisha**

**Sales → Party Price List → New**: Kolkata Garments, item FSJ, rate **420**.

**Sales → Sales Orders → New**: Kolkata Garments, item FSJ, qty **300**.

✅ **Check:** Rate fills in as **420** from the price list.
✅ **Check:** On Save, a warning says the customer will be above the ₹1,00,000 credit limit. Click **Save anyway** → **SO-0001**.

**Sales → Delivery Challans → New**: Kolkata Garments, against **SO-0001**.

✅ **Check:** Qty 300 loads. Choose lot **L-0001 — 560 Kg**, rolls **13**. Save → **DC-0001**.

**Sales → Invoices → New**: Kolkata Garments, against **DC-0001**. Save, and confirm the credit warning.

✅ **Check:** **INV-0001**: taxable **1,26,000.00**, CGST **3,150.00**, SGST **3,150.00**, total **1,32,300.00**.
✅ **Check:** Click **Print**. A tax invoice opens with the amount in words.

**Invoices → New**: Odisha Traders, item FSJ, lot L-0001, qty **100**, change rate to **430**. Save → **INV-0002**.

✅ **Check:** Tax shows as **IGST 2,150.00** (other state), with no CGST/SGST. Total **45,150.00**.

**Invoices → New**: Odisha Traders, FSJ, lot L-0001, qty **500**. Save.

✅ **Check:** The ERP refuses with *"Not enough stock … short by 340"*. Only 160 kg of lot L-0001 is left: 560 − 300 on the challan − 100 on INV-0002.

---

## Step 11 — Finance & Accounts (accounts1)

**Customers → Payment Receipts → New**: Kolkata Garments, amount **50000**, mode UPI. Save.

---

## Step 12 — Management (manager1): check the numbers

Sign in as manager1. You should see the full **Dashboard**.

| Where | What you should see |
|---|---|
| Dashboard | Finished this month **560 kg**, avg cost **₹332.72/kg**; Open sales orders **0**; material in process: yarn in store **400 kg**, finished goods **160 kg** |
| Costing → Lot Costing Sheet | Lot L-0001, 560 kg, total cost **1,86,325.00**; cost/kg **332.72**, cost/roll **7,763.54**, cost/mtr **84.69**; overhead **11,200.00**, packing **120.00** |
| Wastage → Wastage Report | Knitting 15 kg, Dyeing 15 kg, Finishing 10 kg |
| Production → Batch / Lot Tracking | L-0001: yarn 600 → FG 560, **yield 93.33%**, sold 400, FG stock 160 |
| Inventory → Stock Summary | Main Store: yarn 400 kg, Reactive Red 8.3 kg, Soda Ash 41.5 kg, Poly Bag 26. Nothing left at the knitting or color factory |
| Reports → Profitability | Sale value **1,69,000.00**, cost **1,33,089.29**, profit about **35,910** |
| Finance → Receivables | Kolkata Garments **82,300.00**, Odisha Traders **45,150.00** |
| Finance → Payables | Shree Mills **1,79,315.00** |
| Finance → Party Ledger (Kolkata Garments) | Ends at **82,300.00 Dr** |
| Finance → GST Summary | Net GST **−6,615.00** (more input credit than output tax this month) |

How the ₹1,86,325 lot cost adds up:
yarn 600 × 250 = 1,50,000
\+ chemicals 11.7 × 500 + 58.5 × 40 = 8,190
\+ packing 24 × 5 = 120
\+ labour 4,680 + 8,775 + 3,360 = 16,815
\+ overhead 11,200
= **1,86,325**

Part of this total shows in the *Wastage* column: the share of cost that went into the 40 kg of waste.

✅ **Check (access):** manager1 cannot open User Management → Users (**No access**).

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
| knitting1 | Knitting, transfer to color factory, production & stock reports | Dyeing, finishing, sales, GRN, yarn issue |
| dyeing1 | Dyeing, production & stock reports | Knitting, finishing, sales, purchase |
| finishing1 | Finishing & packing, production & stock reports | Knitting, dyeing, sales, GRN |
| sales1 | Customers, price list, orders, challans, invoices, sales reports | Production, bills, payments, overheads |
| accounts1 | Receipts, payments, bills, overheads, invoices (view only), accounts/costing reports, dashboard | Production screens, users |
| manager1 | Everything except users and roles | Users, roles |

A blocked screen shows **No access**, even when you type its address directly.

---

## Automated version of this test

The same scenario runs automatically, with a browser signing in as each department:

```
npm test
```

It needs Node.js 22.13 or newer and Google Chrome or Microsoft Edge. It uses a temporary database, so your real data is never touched. It runs four checks in turn: the storage test (data survives restarts, old `db.json` import), the API rules, the two-tab sign-in test, and this department walkthrough. Each prints a pass/fail line for every check; the walkthrough ends with *ALL 102 CHECKS PASSED*.

It also checks, for every department login, that the menu, each screen and the server all agree on what that login may open or change. That's 116 checks per login.
