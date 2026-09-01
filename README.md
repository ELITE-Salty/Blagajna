# Blagajna · Blu Logistics

Spletna aplikacija za **blagajniške prejemke (BP)**, **blagajniške izdatke (BI)** in
**potrdila o dejavnostih (»dopust liste«)** — po PRD v2.

## Ključna pravila (potrjena)

- Dokumenti med mesecem **nimajo uradne številke** (osnutek / brez uradne številke).
- **Zaključi mesec** dodeli številke **kronološko po času transakcije** (čas vnosa ne šteje;
  izenačevalec: čas vnosa, nato ID). Operacija je atomarna in idempotentna.
- **BP in BI** imata ločeni zaporedji; ponastavitev **vsako koledarsko leto**; števec se začne
  pri 0 → prvi dokument je št. 1.
- Številčenje **po blagajni** (nastavljivo tudi skupno za podjetje — pred prvim zaključkom).
- Zaključen mesec je **zaklenjen**; nikoli se ne odpira/preštevilči — popravki prek **storna**.
- Podpisi so **neobvezni** (risanje s prstom/miško); tisk pusti prazna podpisna polja.
- Neusklajenost časa transakcije z obdobjem potrdila prikaže **opozorilo** (nikoli ne blokira).
- Tisk posnema obstoječe papirne obrazce (BP zelen, BI oranžen, potrdilo = AETR obrazec).

## Zagon (razvoj)

```bash
npm install
npm run dev          # frontend (5173) — /api se preusmeri na localhost:8090
npm run build        # produkcijska gradnja (dist/)
npm run build:single # enodatotečni DEMO predogled (preview-dist/index.html)

# strežnik (2. faza)
cd server && npm install && cd ..
ADMIN_EMAIL=admin@primer.si ADMIN_PASSWORD=geslo12345 node server/index.js
```

## Arhitektura — 2. faza

**En Node.js proces** (`server/`): Express, JWT prijava (bcrypt gesla), vloge
Admin/Računovodja/Finance, sinhronizacijski API (push/pull s konflikti in tombstoni),
**atomaren strežniški zaključek meseca** in revizijska sled. Streže tudi zgrajeni frontend (`dist/`).

**Shramba — dva gonilnika za istim vmesnikom** (`server/store-sqlite.js` / `server/store-pg.js`):

- privzeto **SQLite** datoteka v `data/` (vgrajeni `node:sqlite`, brez konfiguracije);
- z env `DATABASE_URL=postgres://…` **PostgreSQL** (npr. v drugem CT/VM) — shema se ustvari
  samodejno, selitev obstoječih podatkov: `node server/migrate-sqlite-to-pg.js` (glejte DEPLOY.md).

### Normalizirana strežniška baza (schema v3)

Poslovni podatki niso več shranjeni kot en JSON zapis. Glavne tabele so:
`company`, `app_settings`, `cash_desks`, `employees`, `cash_documents`,
`cash_document_rows`, `cash_document_attachments`, `cash_document_signatures`,
`activity_certificates`, `activity_certificate_signatures`, `month_closes`,
`month_close_manifest`, `users` in `audit`. Na iskalnih poljih (mesec, blagajna, datum,
zaposleni, tip/status, konto …) so indeksi, zato je neposredno SQL iskanje in poročanje bistveno lažje.

Stara tabela `records` se zaradi varne nadgradnje **ne izbriše**. Ob prvem zagonu schema v3
samodejno prekopira stare JSON zapise v normalizirane tabele; novi poslovni zapisi se nato
pišejo v normalizirane tabele, `records` pa ostane samo kot legacy/rollback vir.

**Frontend** ob zagonu preveri `/api/health`:

- strežnik dosegljiv → **strežniški način**: prijava, prave vloge, samodejna sinhronizacija
  v ozadju (ob povezavi, vsakih nekaj sekund, ob spremembah), delo brez povezave prek
  lokalne IndexedDB predpomnilnice, zaključek meseca teče na strežniku;
- strežnika ni → **DEMO način**: lokalni predstavitveni podatki, preklop vlog v glavi,
  simulirana sinhronizacija (tako teče predogled v Hyperagent niti).

Varovala na strežniku: zaključeni dokumenti so zaklenjeni (finančnih polj ni mogoče
spremeniti, dovoljena sta oznaka »Prejel« in storno prehod), v zaključen mesec ni mogoče
dodajati dokumentov, šifrante in nastavitve ureja le Admin, mesec se zaključi atomarno in
idempotentno.

## Testi

```bash
npx esbuild test-close.ts --bundle --platform=node --format=cjs --outfile=/tmp/tc.cjs && node /tmp/tc.cjs   # lokalni motor številčenja
DATA_DIR=/tmp/bt ADMIN_EMAIL=nik@test.si ADMIN_PASSWORD=test-geslo-123 node server/index.js &               # testni strežnik
node test-server.mjs                                                                                        # 20 E2E testov API-ja
```

## Namestitev v produkcijo

Glejte **DEPLOY.md** (Docker + Caddy HTTPS ali goli Node.js + systemd, prvi koraki, varnostne kopije).

## Struktura

```
src/
  db.ts               # Dexie shema + predstavitveni podatki
  types.ts            # podatkovni model (PRD §37–§42)
  lib/numbering.ts    # predogled številčenja, atomaren zaključek meseca, storno
  lib/besede.ts       # znesek z besedo (slovensko)
  lib/perms.ts        # matrika pravic (PRD §44)
  print.tsx           # papirni izpisi: BP, BI, potrdilo o dejavnostih (AETR)
  views/              # blagajna (hitra mreža), potrdila, zaposleni, nastavitve, revizija
```

## Excel izvoz in predloge za zaposlene

- **Poročila in izvoz** zdaj ustvarijo pravi `.xlsx` dokument z listoma **Povzetek** in **Podrobnosti**, Excel filtri, zamrznjeno glavo, oblikovanimi statusi/tipi ter pravimi številčnimi EUR celicami.
- V **Zaposleni** sta na voljo gumba **Excel predloga** in **CSV predloga**. Excel predloga vsebuje navodila, oblikovane datumske stolpce in izbiro `Da/Ne` za aktivnost.
- Uvoz zaposlenih sprejme CSV/TSV z ločilom `;`, `,` ali tabulatorjem. Datumi so lahko zapisani kot `yyyy-mm-dd` ali `dd.mm.yyyy`.
