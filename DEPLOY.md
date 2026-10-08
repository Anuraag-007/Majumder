# Putting the ERP online on Hostinger

There are two ways, depending on your Hostinger plan:

- **A. Business Web Hosting** (Node.js Web App). Hostinger manages the server and HTTPS for you. **Start here if you have the Business plan.**
- **B. VPS.** You manage the server yourself (further down this page).

The **Premium** plan cannot run this ERP: it hosts websites only, not Node.js programs.

---

# A. Hostinger Business plan

**Read this first.** On this plan Hostinger **wipes and replaces the app's folder every time you deploy or update**. Your database must therefore live in a **separate folder outside the app**, and you tell the ERP where it is with the setting `DATA_DIR`. If you skip that, every update would start you with an empty ERP.

Menu names below may differ slightly in your hPanel; look for the nearest match.

## A1. Prepare on the office PC

1. **Change the admin password** (sign in as admin → *User Management → Settings & Password → Change my password*). On the internet, `admin123` is an open door.
2. **Download your database:** *Settings & Password → Download database (SQLite)*. You get a file like `erp-2026-10-07.sqlite`. This is all your data.
3. **From now on, stop entering data on the office PC.** Anything entered there after the download will not be online.
4. **Make the upload package.** Open PowerShell and paste:

```powershell
$src = "C:\Users\ANURAAG\Desktop\Majumder"
Compress-Archive -Path "$src\server.js", "$src\server", "$src\public", "$src\package.json" -DestinationPath "$env:USERPROFILE\Desktop\erp-upload.zip" -Force
```

`erp-upload.zip` (about 100 KB) appears on your Desktop. It holds the program only, never your data.

## A2. Put your database in its own folder (before the first deploy)

1. Open **hPanel → Files → File Manager**. At the top level (the folder that contains `domains` and `public_html`) create a new folder named **`erp-data`**.
2. Open `erp-data`, **upload** the database file you downloaded, and **rename** it to exactly **`erp.sqlite`**.
3. Note the full path of the folder. It looks like **`/home/u123456789/erp-data`** (your `u…` number is shown in File Manager and in hPanel's account details). You need it in step A3.

## A3. Create the Node.js app

**Using a subdomain** (e.g. `erp.yourdomain.com`, while your main site stays on `yourdomain.com`):

- If that subdomain **already appears in hPanel as a website or subdomain**, remove it first: Hostinger's Node.js setup needs to create the slot for it itself. Only do this if nothing is stored there yet, because removing a website deletes its files. Your main domain's website is not affected.
- If your domain's nameservers are at Hostinger, the subdomain's DNS is set up automatically. If the domain is managed elsewhere, add the DNS record hPanel shows you at that provider.

1. **hPanel → Websites → Add / Create website → Web App** (Node.js) → **Upload your website files** → upload **`erp-upload.zip`**.
2. When asked for the domain, enter or choose your subdomain, for example **`erp.yourdomain.com`**. (If the screen only offers existing domains, first add the subdomain under **hPanel → Domains → Subdomains**, then link it to the app.)
3. Build settings:

| Setting | Value |
|---|---|
| Framework | **Express.js** (or **Other**) |
| Node.js version | **24.x** (22.x also works) |
| Entry file | **`server.js`** |
| Build command | leave **empty** (nothing to build) |
| Start command | **`npm start`** |
| Output directory | leave **empty** |

4. **Environment variables**: add these (use your own `u…` number):

| Name | Value |
|---|---|
| `DATA_DIR` | `/home/u123456789/erp-data` |
| `TRUST_PROXY` | `1` |
| `NODE_ENV` | `production` |

Do **not** set `PORT` or `HOST`; Hostinger provides the port itself.

5. Click **Deploy**.

## A4. Check it

1. Make sure HTTPS is on: **hPanel → Security → SSL** should show the certificate as active for the **subdomain itself** (`erp.yourdomain.com`), not only the main domain. If it isn't listed, install the free SSL for it there. It can take a few minutes up to a few hours after the subdomain is created.
2. Open **https://erp.yourdomain.com** and **sign in with your own users and passwords**. Your items, parties and invoices should all be there.
   - If you instead see an **empty ERP that accepts admin / admin123**, the ERP did not find your database: `DATA_DIR` is wrong or the file is not named `erp.sqlite`. Correct the variable and redeploy. Your uploaded file is not harmed.
3. **Prove the data survives an update** (do this once):
   - Add a test unit in *Masters → Units*.
   - In hPanel **redeploy** the app (or upload the same zip again).
   - Check the test unit is still there, then delete it.

## A5. Backups

- **Automatic:** while the ERP runs it saves a backup **once a day** into `erp-data/backups/` and keeps the newest 30.
- **Weekly:** download a copy to the office (*Settings → Download database (SQLite)*).
- **Hostinger's own account backups** (hPanel → Files → Backups) are an extra safety net.

## A6. Updating the ERP later

1. On the PC make a new `erp-upload.zip` (step A1.4).
2. In hPanel open the web app and **upload the new files / redeploy**.

Your database is safe because it lives in `erp-data`, outside the app folder. After an update everyone signs in again and presses **Ctrl + F5** once.

## A7. If something goes wrong

| What you see | What to do |
|---|---|
| Empty ERP, admin / admin123 works | `DATA_DIR` is wrong or the file isn't named `erp.sqlite`. Fix and redeploy |
| Log or screen mentions **disk I/O error** or **database is locked** | Add the environment variable `SQLITE_JOURNAL` = `DELETE`, then redeploy |
| Log says *needs Node.js 22.13 or newer* | Choose Node.js **24.x** in the build settings and redeploy |
| *Too many wrong passwords. Sign-in is paused* | After 5 wrong passwords that name is paused for 15 minutes from that address; wait, or restart the app in hPanel |
| Everyone was signed out | The app was restarted or updated (sign-ins live in memory). Sign in again |

**Good to know:**
- **Run one copy only.** Use one app, and don't keep using the office PC server as well; they would be two separate databases.
- **Restoring a backup:** stop the app in hPanel. In File Manager, copy the chosen file from `erp-data/backups/` over `erp-data/erp.sqlite`, first deleting `erp.sqlite-wal` and `erp.sqlite-shm` if present. Then start the app again.

---

# B. Hostinger VPS (alternative)

A VPS (Hostinger *KVM 1* is enough to start) gives you full control. The database lives safely on the server's disk and PM2 keeps the ERP running.

You will need:
- a Hostinger VPS with **Ubuntu 24.04**
- a domain or subdomain you control (examples below use `erp.yourdomain.com`; replace it everywhere)
- about one hour

Commands in **grey boxes** are copied and pasted. `YOUR_VPS_IP` is your VPS address and `erp.yourdomain.com` is your address.

---

## B1. Prepare on the office PC

1. **Change the admin password.** Sign in as admin → *User Management → Settings & Password → Change my password*. On the internet, `admin123` is an open door. The server prints a warning while it is still the default.
2. **Download your database.** *Settings & Password → Download database (SQLite)*. You get `erp-YYYY-MM-DD.sqlite`. This is all your data.
3. **Stop entering data on the office PC from this point.** Anything entered locally after the download will not be online. When the online ERP is working, close the office server for good.
4. **Make the upload package.** Open PowerShell and paste:

```powershell
$src = "C:\Users\ANURAAG\Desktop\Majumder"
Compress-Archive -Path "$src\server.js", "$src\server", "$src\public", "$src\package.json", "$src\ecosystem.config.js" -DestinationPath "$env:USERPROFILE\Desktop\erp-upload.zip" -Force
```

This puts `erp-upload.zip` on your Desktop. It holds the program only; your data travels separately (step B4).

## B2. Create the VPS on Hostinger

1. In **hPanel → VPS**, set up the server with the operating system **Ubuntu 24.04** (plain OS, no control panel).
2. Set a strong **root password** and note the **IP address** shown on the VPS overview.
3. **Point your address at the VPS:** in **hPanel → Domains → DNS / Nameservers** for your domain, add an **A record**: name `erp`, points to `YOUR_VPS_IP`. (If your domain is with another registrar, add the same A record there.) It can take from a few minutes to a few hours to start working.

## B3. Install the software on the VPS

From your PC's PowerShell, connect to the server (type `yes` the first time, then the root password):

```powershell
ssh root@YOUR_VPS_IP
```

(hPanel also has a **Browser terminal** button that does the same.) Then paste this block:

```bash
apt update && apt -y upgrade
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt -y install nodejs nginx certbot python3-certbot-nginx unzip
npm install -g pm2
adduser --disabled-password --gecos "" erp
mkdir -p /var/www/erp/data/backups
node -v
```

The last line must show **v24** (anything **22.13 or newer** works).

## B4. Upload the program and your data

Open a **second** PowerShell window on your PC (leave the server one open) and upload both files. Change the database file name to the one you downloaded:

```powershell
scp "$env:USERPROFILE\Desktop\erp-upload.zip" root@YOUR_VPS_IP:/root/
scp "$env:USERPROFILE\Downloads\erp-2026-10-07.sqlite" root@YOUR_VPS_IP:/root/erp.sqlite
```

Back in the **server** window:

```bash
cd /var/www/erp
unzip -o /root/erp-upload.zip
mv /root/erp.sqlite /var/www/erp/data/erp.sqlite
chown -R erp:erp /var/www/erp
```

## B5. Start the ERP and keep it running

```bash
cd /var/www/erp
sudo -u erp -H pm2 start ecosystem.config.js
sudo -u erp -H pm2 save
pm2 startup systemd -u erp --hp /home/erp
sudo -u erp -H pm2 logs erp --lines 15 --nostream
```

The log should say **`Majumdaar Hosiery ERP running at http://127.0.0.1:3000`** and **`Database: /var/www/erp/data/erp.sqlite (SQLite)`**. PM2 restarts the ERP if it ever stops, and starts it again after a server reboot.

The ERP only listens inside the server (`127.0.0.1`). The next step puts a secure HTTPS front door (Nginx) in front of it.

## B6. Connect your address with HTTPS

Create the web server settings. Change `erp.yourdomain.com` on the second line first:

```bash
cat > /etc/nginx/sites-available/erp <<'EOF'
server {
    listen 80;
    server_name erp.yourdomain.com;
    client_max_body_size 25m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/erp /etc/nginx/sites-enabled/erp
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

Get the free HTTPS certificate. Use your address and your email; it renews by itself:

```bash
certbot --nginx -d erp.yourdomain.com --redirect --agree-tos -m you@yourdomain.com
```

Turn on the firewall (only SSH and the web are allowed in):

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

Open **https://erp.yourdomain.com** and sign in. Your data, users and settings are all there.

## B7. Nightly backups

```bash
sudo -u erp crontab -l 2>/dev/null | { cat; echo '30 2 * * * cd /var/www/erp && /usr/bin/node server/backup.js >> /var/www/erp/data/backups/backup.log 2>&1'; } | sudo -u erp crontab -
```

Every night at 2:30 a consistent copy goes to `/var/www/erp/data/backups/` and the newest 30 are kept.

Also:
- once a week, download a copy to the office: *Settings → Download database (SQLite)*
- turn on **automatic backups / snapshots** for the VPS in hPanel

A backup that only lives on the same server is not enough.

## B8. Updating the ERP later

1. On the PC, make a new `erp-upload.zip` (step B1.4).
2. Upload it: `scp "$env:USERPROFILE\Desktop\erp-upload.zip" root@YOUR_VPS_IP:/root/`
3. On the server:

```bash
cd /var/www/erp && unzip -o /root/erp-upload.zip && chown -R erp:erp /var/www/erp && sudo -u erp -H pm2 restart erp
```

The zip never contains `data/`, so your database is never overwritten. After a restart everyone signs in again and presses **Ctrl + F5** once.

## B9. If something goes wrong

| What you see | What to do |
|---|---|
| **502 Bad Gateway** | The ERP is not running: `sudo -u erp -H pm2 status` and `sudo -u erp -H pm2 logs erp --lines 50 --nostream` |
| Log says *needs Node.js 22.13 or newer* | `node -v`; repeat the Node install line in step 3 |
| Certbot fails | The `erp` A record is not working yet. Wait, then check with `ping erp.yourdomain.com` |
| *Too many wrong passwords. Sign-in is paused* | After 5 wrong passwords that name is paused for 15 minutes from that address. Wait, or `sudo -u erp -H pm2 restart erp` |
| Need to restore a backup | `sudo -u erp -H pm2 stop erp`, copy the chosen file over `data/erp.sqlite` (remove `erp.sqlite-wal` and `erp.sqlite-shm` first), `chown erp:erp`, then `sudo -u erp -H pm2 start erp` |

## B10. Good to know

- **Run one copy only.** Don't use the office PC server and the online one at the same time: they are two separate databases.
- **Sign-in protection:** 5 wrong passwords for one user from one address, or 30 from one address, pause sign-in there for 15 minutes.
- **Security headers:** the ERP sends headers that stop it being framed inside other sites.
- **Phones and tablets:** they work at the same `https://` address.
