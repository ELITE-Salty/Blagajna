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


## Glavna/globalna blagajna in ločen uvoz akontacij

- **Glavna/globalna blagajna** je zbirnik več internih lokacij (npr. `Glavna blagajna (GB)` → `Pisarna`, `Direktor`).
  Dokumenti se vedno knjižijo na konkretno interno lokacijo, globalni pogled pa prikazuje skupno stanje in stanje po lokacijah.
- V **Nastavitve → Struktura blagajn** je hierarhija prikazana kot drevo: glavna blagajna zgoraj, interne blagajne pod njo.
- V glavnem zavihku **Blagajna** izbirnik prikazuje isto hierarhijo. Izberite `🏦 Glavna blagajna — SKUPAJ` za skupni pregled ali `↳ Pisarna` / `↳ Direktor` za posamezno interno blagajno.
- **Uvoz zaposlenih CSV ostaja ločen** v zavihku **Zaposleni → Uvoz zaposlenih CSV** in samo dodaja/posodablja zaposlene.
- V mesečnem pogledu Blagajne je ločen **Uvoz akontacij (Excel/CSV)**. Ta uvoz ne spreminja zaposlenih; obstoječe zaposlene samo poišče po imenu in priimku ter ustvari BI dokumente. Podprta sta `.xlsx` (prvi delovni list) in CSV.
  Pričakovani stolpci so `Ime`, `Priimek`, `Znesek`/`Vrednost` (ali en stolpec `Ime in priimek`).
- Izvorni znesek **do vključno 700 €** ostane en BI. Če je znesek **nad 700 €**, se razdeli na več BI postavk med **300 € in 500 €**.
  Vmesni deli so praviloma v korakih po 5 €, zadnji del pa po potrebi prevzame natančen ostanek do centa, zato je **vsota vseh delov vedno natančno enaka izvornemu znesku** in se uvoženi skupni znesek ne zaokrožuje.
- Datumi se določajo v oknu **od 20. izbranega meseca do 16. naslednjega meseca**. Za razdeljene akontacije se posamezni BI razporedijo na **več različnih dni in različnih ur**. Začetni/končni datumi povezanih potrdil o dejavnostih (»dopust listov«) imajo prednost, preostali deli pa se razpršijo po veljavnem oknu.
- Pred shranjevanjem se pokaže predogled vseh ustvarjenih BI dokumentov. Uvoz je blokiran pri neujemajočih zaposlenih, zaključenih mesecih
  ali če na izbrani interni blagajni ni dovolj sredstev. Vzorec: `akontacije-import-vzorec.csv` (zaradi združljivosti je ohranjen tudi prejšnji `izplacila-import-vzorec.csv`).


### Interni prenosi med blagajnami

- V zavihku **Blagajna** je ločena akcija **↔ Interni prenos** za premik gotovine med dvema aktivnima internima blagajnama iste glavne/globalne blagajne.
- Interni prenos **ni BP ali BI**, zato ne dobi BP/BI številke in ne porablja zaporedja številčenja.
- Znesek se na izvorni blagajni odšteje, na ciljni blagajni pa prišteje. Pri prenosu med dvema otrokoma iste globalne blagajne se skupni saldo globalne blagajne ne spremeni.
- Vsak prenos ima datum, čas, izvorno blagajno, ciljno blagajno, znesek in neobvezno opombo ter je viden v evidenci pri obeh blagajnah.
- Prenos ni dovoljen, če izvorna blagajna nima dovolj gotovine ali če je mesec izvorne oziroma ciljne blagajne že zaključen.
- **Poročila** imajo ločeno tabelo in CSV izvoz internih prenosov. V **Blagajniški knjigi** so prenosi vključeni v saldo kot vrstice `PRENOS`, ne kot BP/BI.
- Neusklajeni prenosi blokirajo zaključek meseca enako kot drugi neusklajeni poslovni podatki; po zaključku meseca so zaklenjeni.

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
`company`, `app_settings`, `cash_desks`, `cash_transfers`, `employees`, `cash_documents`,
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
