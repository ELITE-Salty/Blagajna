# Namestitev v produkcijo — Blagajna · Blu Logistics

Aplikacija je **en sam strežniški proces** (Node.js), ki streže spletno aplikacijo in API ter
hrani podatke v **SQLite** datoteki (mapa `data/`). Brskalniki uporabnikov imajo lokalni
predpomnilnik za delo brez povezave in se **samodejno sinhronizirajo** s strežnikom.

---

## Možnost A — VPS + Docker (priporočeno, ~15 minut)

Deluje na katerem koli Linux strežniku (Hetzner, DigitalOcean, domači strežnik …).
Priporočen najmanjši VPS (2 GB RAM) je več kot dovolj.

### 1. Predpogoji na strežniku

```bash
# namestite Docker (uradna skripta)
curl -fsSL https://get.docker.com | sh
```

### 2. Prenesite projekt na strežnik

Kopirajte mapo projekta (zip ali git) v npr. `/opt/blagajna` in:

```bash
cd /opt/blagajna
cp .env.example .env
nano .env        # nastavite ADMIN_EMAIL, ADMIN_PASSWORD (prvi administrator)
```

### 3. Zagon

```bash
docker compose up -d --build --force-recreate
```

`--build --force-recreate` je pomemben tudi pri tej različici, da se zažene nova slika containerja.
Frontend ponovno uporablja izvorne brskalnikove izbirnike za mesec, datum in čas; HTML pa se streže z `Cache-Control: no-store`, da brskalnik po nadgradnji ne obdrži stare različice aplikacije.

Aplikacija teče na `http://IP-STREŽNIKA:8090`. Podatki so v `/opt/blagajna/data/`.

### 4. HTTPS z domeno (močno priporočeno)

Brez HTTPS gesla potujejo nešifrirano. Najlažje s **Caddy** (samodejni Let's Encrypt certifikati):

1. V DNS usmerite npr. `blagajna.blu-logistics.si` → IP strežnika (A zapis).
2. V `docker-compose.yml` dodajte servis in odstranite objavo porta 8090 navzven:

```yaml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
volumes:
  caddy_data:
```

3. Ustvarite `Caddyfile`:

```
blagajna.blu-logistics.si {
    reverse_proxy blagajna:8090
}
```

4. `docker compose up -d` — čez minuto deluje `https://blagajna.blu-logistics.si` z veljavnim certifikatom.

> Če aplikacijo uporabljate **samo v pisarniškem omrežju (LAN)**, lahko HTTPS izpustite,
> a se zavedajte, da so gesla takrat vidna v lokalnem omrežju.

---

## Možnost B — brez Dockerja (Node.js neposredno)

Potrebujete Node.js **22.5 ali novejši** (uporablja vgrajeni SQLite).

```bash
# 1) gradnja frontenda
npm ci
npm run build

# 2) strežnik
cd server && npm ci --omit=dev && cd ..

# 3) zagon (prvi zagon ustvari administratorja)
ADMIN_EMAIL=nik.kopi@blu-logistics.si ADMIN_PASSWORD=mocno-geslo \
DATA_DIR=./data PORT=8090 node server/index.js
```

Za samodejni zagon ob ponovnem zagonu strežnika (Linux, systemd) ustvarite
`/etc/systemd/system/blagajna.service`:

```ini
[Unit]
Description=Blagajna Blu Logistics
After=network.target

[Service]
WorkingDirectory=/opt/blagajna
ExecStart=/usr/bin/node server/index.js
Environment=DATA_DIR=/opt/blagajna/data
Environment=PORT=8090
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now blagajna
```

(Na Windows strežniku enako doseže orodje NSSM ali »Task Scheduler« z ukazom `node server\index.js`.)

---

## Zunanja baza PostgreSQL (v drugem CT / VM) — neobvezno

Privzeto aplikacija uporablja **SQLite datoteko** v mapi `data/` — za pisarniško rabo povsem
dovolj in brez vzdrževanja. Če pa bazo raje gostite ločeno (npr. PostgreSQL v svojem
Proxmox CT ali VM), je preklop ena sama nastavitev:

### 1. Pripravite bazo (na PostgreSQL strežniku)

```sql
CREATE USER blagajna WITH PASSWORD 'mocno-geslo';
CREATE DATABASE blagajna OWNER blagajna;
```

(V `pg_hba.conf` / `listen_addresses` dovolite dostop z IP-ja aplikacijskega strežnika.)

### 2. Nastavite DATABASE_URL in ponovno zaženite

V `.env` dodajte:

```
DATABASE_URL=postgres://blagajna:mocno-geslo@10.0.0.5:5432/blagajna
```

in `docker compose up -d`. Shema se ob prvem zagonu ustvari samodejno.
Brez `DATABASE_URL` aplikacija tiho uporablja SQLite — preklop nazaj je enako preprost.

### 3. Selitev obstoječih podatkov (če ste že delali na SQLite)

```bash
DATABASE_URL=postgres://blagajna:mocno-geslo@10.0.0.5:5432/blagajna \
node server/migrate-sqlite-to-pg.js ./data
```

Skript prenese uporabnike, vse dokumente, zaključke in revizijsko sled v normalizirano
PostgreSQL shemo. Je idempotenten (lahko ga varno ponovno zaženete), SQLite datoteka pa ostane
nedotaknjena kot varnostna kopija. (V Dockerju: `docker compose run --rm -e DATABASE_URL=... blagajna node server/migrate-sqlite-to-pg.js /data`.)

### Varnostne kopije pri PostgreSQL

Namesto kopije mape `data/` uporabite `pg_dump`:

```bash
pg_dump -U blagajna -h 10.0.0.5 blagajna > /backup/blagajna-$(date +%F).sql
```

(`data/jwt-secret` še vedno varnostno kopirajte ali nastavite fiksni `JWT_SECRET` v `.env`,
sicer se ob izgubi uporabniki zgolj znova prijavijo.)

---

## Prvi koraki po namestitvi

1. Odprite aplikacijo in se prijavite s podatki iz `.env` (prvi administrator).
2. **Nastavitve → Podjetje**: izpolnite naziv, naslov, telefon, e-pošto, izjavitelja (za potrdila).
3. **Nastavitve → Blagajne**: ustvarite blagajne (npr. Glavna blagajna).
4. **Nastavitve → Številčenje**: preverite obseg (privzeto po blagajni) — po prvem zaključku meseca se ne spreminja več.
5. **Nastavitve → Uporabniki**: dodajte računovodjo in finance (vsak svoje geslo).
6. **Zaposleni**: vnesite voznike (datum rojstva, št. dovoljenja, datum zaposlitve — za potrdila).
7. Začnite z vnosom dokumentov. Vse se sinhronizira samodejno; značka v glavi pokaže stanje.

## Varnostne kopije

Vsi podatki so v mapi `data/` (SQLite + WAL + JWT skrivnost). Kopija te mape = popolna varnostna kopija.

```bash
# primer: dnevna kopija ob 2h (crontab -e)
0 2 * * * tar czf /backup/blagajna-$(date +\%F).tgz -C /opt/blagajna data
```

Obnova: ustavite aplikacijo, zamenjajte mapo `data/`, zaženite.

## Posodobitev na novo različico

```bash
cd /opt/blagajna
# prenesite/odpakirajte novo različico kode (data/ pustite pri miru!)
docker compose up -d --build --force-recreate
```

Ob prvem zagonu te različice se stari JSON zapisi samodejno prekopirajo v normalizirane tabele.
Tabele `records` ne brišite ročno; ostane kot legacy varnostna sled in se za nove poslovne zapise ne uporablja.

## Odpravljanje težav

- `curl http://localhost:8090/api/health` → mora vrniti `{"ok":true,"name":"blagajna",...}`
- dnevniki: `docker compose logs -f blagajna`
- Aplikacija v brskalniku javi »DEMO« → brskalnik ne doseže API-ja na istem naslovu (preverite proxy/port).
- Pozabljeno admin geslo → na strežniku zaženite z novim `ADMIN_EMAIL`/`ADMIN_PASSWORD` **ne pomaga** (uporabniki že obstajajo); geslo ponastavi drug administrator v Nastavitve → Uporabniki. Če ni nobenega administratorja več, izbrišite datoteko `data/blagajna.sqlite` (izgubite podatke!) ali nas kontaktirajte za SQL ukaz.

### Preverjanje različice v4 (interni prenosi)

Po nadgradnji mora biti v modrem bloku **Hierarhija blagajne** vidna značka **v4 · interni prenosi**.
Če je ne vidite, strežnik še vedno streže star frontend. Pri Docker namestitvi ponovno zaženite:

```bash
docker compose up -d --build --force-recreate
```

Nato v brskalniku naredite trdi refresh (`Ctrl+Shift+R` oziroma `Cmd+Shift+R`).
V v4 je gumb **↔ Interni prenos** v modrem bloku hierarhije in tudi v vrstici akcij nad tabelo, kadar ima ista glavna blagajna vsaj dve aktivni interni blagajni.
